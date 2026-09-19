import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { resetStorage } from '../storage';
import { insertContentReview } from '../db/repositories/reviews';
import { deletePhoto } from './deletionService';
import { readPhotoForUser, uploadPhoto, type UploadFile } from './photoService';

vi.mock('../db/repositories/reviews', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/repositories/reviews')>();
  return { ...actual, insertContentReview: vi.fn(actual.insertContentReview) };
});

/**
 * M01 §9 用例 4–9：上传校验、去重与跨用户、三写回滚、读图鉴权、`?w=` 缩放、删除幂等。
 */
const USER_A = 1;
const USER_B = 2;
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-photo-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  process.env.STORAGE_DIR = path.join(tmpDir, 'storage');
  closeDb();
  resetStorage();
  runMigrations();
  runSeed();
  getDb()
    .prepare(
      `INSERT INTO users (id, phone, nickname, status, daily_image_quota, created_at)
       VALUES (2, '13900000000', 'USER_B', 1, 20, '2026-01-01T00:00:00Z')`,
    )
    .run();
});

afterAll(() => {
  closeDb();
  resetStorage();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.STORAGE_DIR;
});

const jpeg = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 180, g: 120, b: 90 } } })
    .jpeg()
    .toBuffer();

const asFile = (buffer: Buffer, type = 'image/jpeg'): UploadFile => ({
  type,
  size: buffer.byteLength,
  arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
});

const countPhotos = (): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n;
const countReviews = (): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM content_reviews').get() as { n: number }).n;
const countAudit = (action: string): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?').get(action) as { n: number })
    .n;
const storageFiles = (): number => {
  const root = process.env.STORAGE_DIR as string;
  if (!fs.existsSync(root)) return 0;
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).length;
};

describe('用例 4 · 上传校验', () => {
  it('非法 mime / 空 type → INVALID_FILE_TYPE；超限 → FILE_TOO_LARGE；均无新文件、无新行', async () => {
    const before = { rows: countPhotos(), files: storageFiles() };
    for (const type of ['image/gif', 'text/plain', '']) {
      await expect(uploadPhoto({ userId: USER_A, file: asFile(Buffer.from('x'), type) })).rejects.toMatchObject(
        { code: 'INVALID_FILE_TYPE' },
      );
    }
    const maxBytes = Number(process.env.MAX_UPLOAD_MB ?? 20) * 1024 * 1024;
    await expect(
      uploadPhoto({ userId: USER_A, file: { type: 'image/jpeg', size: maxBytes + 1, arrayBuffer: async () => new ArrayBuffer(0) } }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(countPhotos()).toBe(before.rows);
    expect(storageFiles()).toBe(before.files);
  });
});

describe('用例 5 · 去重与跨用户', () => {
  it('同用户同 buffer 第二次复用同一 id；用户 B 相同 buffer 落新行新文件', async () => {
    const buffer = await jpeg(300, 200);
    const first = await uploadPhoto({ userId: USER_A, file: asFile(buffer) });
    const rowsAfterFirst = countPhotos();
    const filesAfterFirst = storageFiles();

    const second = await uploadPhoto({ userId: USER_A, file: asFile(buffer) });
    expect(second.id).toBe(first.id);
    expect(countPhotos()).toBe(rowsAfterFirst); // 未新增行
    expect(storageFiles()).toBe(filesAfterFirst); // 未新增文件
    expect(countReviews()).toBe(2); // 每次上传各一行
    expect(countAudit('photo.upload')).toBe(2);
    const secondAudit = getDb()
      .prepare("SELECT meta_json FROM audit_logs WHERE action = 'photo.upload' ORDER BY id DESC LIMIT 1")
      .get() as { meta_json: string };
    expect(JSON.parse(secondAudit.meta_json).deduped).toBe(true);

    const other = await uploadPhoto({ userId: USER_B, file: asFile(buffer) });
    expect(other.id).not.toBe(first.id);
    expect(countPhotos()).toBe(rowsAfterFirst + 1);
    expect(storageFiles()).toBe(filesAfterFirst + 1);
  });
});

describe('用例 6 · 三写一致性回滚', () => {
  it('content_reviews 写入失败 → 事务回滚、无新行、磁盘文件被清理', async () => {
    const before = { rows: countPhotos(), files: storageFiles() };
    vi.mocked(insertContentReview).mockImplementationOnce(() => {
      throw new Error('forced review failure');
    });
    const buffer = await jpeg(320, 240);
    await expect(uploadPhoto({ userId: USER_A, file: asFile(buffer) })).rejects.toMatchObject({
      code: 'STORAGE_ERROR',
    });
    expect(countPhotos()).toBe(before.rows);
    expect(storageFiles()).toBe(before.files);
  });
});

describe('用例 7 · 读图归属与软删', () => {
  it('用户 B 读 A 的照片 → 404；软删后立刻读 → 404 且盘上文件仍在', async () => {
    const photo = await uploadPhoto({ userId: USER_A, file: asFile(await jpeg(240, 240)) });
    await expect(readPhotoForUser({ userId: USER_B, photoId: photo.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    deletePhoto({ userId: USER_A, photoId: photo.id });
    await expect(readPhotoForUser({ userId: USER_A, photoId: photo.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(fs.existsSync(path.join(process.env.STORAGE_DIR as string, photo.storageKey))).toBe(true);
  });
});

describe('用例 8 · ?w= 缩放与不放大', () => {
  it('w=400 → jpeg 且宽 400；不传 w → 原 mime / 原字节；小图请求大 w 不放大', async () => {
    const big = await uploadPhoto({ userId: USER_A, file: asFile(await jpeg(1200, 800)) });
    const scaled = await readPhotoForUser({ userId: USER_A, photoId: big.id, width: 400 });
    expect(scaled.contentType).toBe('image/jpeg');
    expect((await sharp(scaled.body).metadata()).width).toBe(400);

    const raw = await readPhotoForUser({ userId: USER_A, photoId: big.id });
    expect(raw.contentType).toBe(big.mime);
    expect(raw.body.byteLength).toBe(big.bytes);

    const small = await uploadPhoto({ userId: USER_A, file: asFile(await jpeg(200, 150)) });
    const enlarged = await readPhotoForUser({ userId: USER_A, photoId: small.id, width: 800 });
    expect((await sharp(enlarged.body).metadata()).width).toBe(200);
  });
});

describe('用例 9 · 删除幂等', () => {
  it('连续两次 DELETE 均 ok，第二次 cascaded 全 0，且只写一条 photo.delete 审计', async () => {
    const photo = await uploadPhoto({ userId: USER_A, file: asFile(await jpeg(210, 210)) });
    const before = countAudit('photo.delete');
    const first = deletePhoto({ userId: USER_A, photoId: photo.id });
    expect(first.ok).toBe(true);
    expect(first.cascaded).toEqual({ preprocessed: 0, anchors: 0, generations: 0, results: 0 });
    const second = deletePhoto({ userId: USER_A, photoId: photo.id });
    expect(second.cascaded).toEqual({ preprocessed: 0, anchors: 0, generations: 0, results: 0 });
    expect(countAudit('photo.delete')).toBe(before + 1);
  });
});
