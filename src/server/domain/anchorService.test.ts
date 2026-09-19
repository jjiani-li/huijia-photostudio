import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { resetStorage } from '../storage';
import { preprocessPhoto } from './anchorService';
import { uploadPhoto, type UploadFile } from './photoService';

/**
 * `POST /api/photos/:id/preprocess` 的服务层语义（`docs/prd/modules/M02-预处理与质量评分.md` §5.3、§6.3）。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-preprocess-'));
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

const asFile = (buffer: Buffer): UploadFile => ({
  type: 'image/jpeg',
  size: buffer.byteLength,
  arrayBuffer: async () =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
});

const jpeg = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 140, g: 120, b: 100 } } }).jpeg().toBuffer();

const countPreprocessed = (): number =>
  (getDb().prepare("SELECT COUNT(*) AS n FROM photos WHERE kind = 'preprocessed'").get() as { n: number }).n;

describe('preprocessPhoto', () => {
  it('产出唯一 preprocessed 行 + 审计，幂等复用', async () => {
    const original = await uploadPhoto({ userId: 1, file: asFile(await jpeg(900, 600)) });
    const before = countPreprocessed();

    const first = await preprocessPhoto(1, original.id);
    expect(first.photo.kind).toBe('preprocessed');
    expect(first.photo.sourcePhotoId).toBe(original.id);
    expect(first.photo.mime).toBe('image/jpeg');
    expect(countPreprocessed()).toBe(before + 1);
    const audits = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'photo.preprocess'")
        .get() as { n: number }
    ).n;
    expect(audits).toBe(1);

    const second = await preprocessPhoto(1, original.id);
    expect(second.photo.id).toBe(first.photo.id); // 复用同一行
    expect(second.quality).toEqual(first.quality);
    expect(countPreprocessed()).toBe(before + 1);
    const audits2 = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'photo.preprocess'")
        .get() as { n: number }
    ).n;
    expect(audits2).toBe(1); // 幂等不写新审计
  });

  it('kind != original → INVALID_PARAM', async () => {
    const original = await uploadPhoto({ userId: 1, file: asFile(await jpeg(700, 500)) });
    const pre = await preprocessPhoto(1, original.id);
    await expect(preprocessPhoto(1, pre.photo.id)).rejects.toMatchObject({ code: 'INVALID_PARAM' });
  });

  it('他人照片 / 不存在 → NOT_FOUND', async () => {
    const original = await uploadPhoto({ userId: 1, file: asFile(await jpeg(640, 480)) });
    await expect(preprocessPhoto(2, original.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(preprocessPhoto(1, 999999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('并发调用不会把属主的 in-flight 结果泄漏给他人', async () => {
    const original = await uploadPhoto({ userId: 1, file: asFile(await jpeg(880, 660)) });
    const [owner, other] = await Promise.allSettled([
      preprocessPhoto(1, original.id),
      preprocessPhoto(2, original.id),
    ]);
    expect(owner.status).toBe('fulfilled');
    expect(other.status).toBe('rejected');
    if (other.status === 'rejected') expect(other.reason).toMatchObject({ code: 'NOT_FOUND' });
  });
});
