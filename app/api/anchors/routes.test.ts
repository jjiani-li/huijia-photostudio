import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { anchorSchema, qualitySchema } from '../../../src/shared/types';
import { closeDb, getDb } from '../../../src/server/db/connection';
import { runMigrations } from '../../../src/server/db/migrate';
import { runSeed } from '../../../src/server/db/seed';
import { buildKey, getStorage, resetStorage } from '../../../src/server/storage';
import { insertPhoto } from '../../../src/server/db/repositories/photos';
import { nowIso } from '../../../src/server/domain/time';
import { readFixture } from '../../../src/server/ark/fixtures';
import { anchorExtractHandler } from '../../../src/jobs/handlers/anchorExtract';
import { POST } from './route';
import { GET } from './[id]/route';
import { POST as RETRY } from './[id]/retry/route';
import { POST as UPLOAD } from '../photos/route';
import { POST as PREPROCESS } from '../photos/[id]/preprocess/route';

/**
 * 锚点端点层断言（`docs/prd/spec/03-接口契约.md` §3.3、`docs/prd/spec/07-验收标准.md` §2）：
 * `SEC-06`（`kind='generated'` → `400 INVALID_PARAM`）、张数与归属校验、`API-02`（响应形状走 shared schema）、
 * `retry` 新行语义，以及低质量样本回放后 `GET /api/anchors/:id` 的失败呈现。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-anchor-api-'));
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

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const asReq = (req: Request) => req as unknown as NextRequest;
const body = <T>(req: Request, payload: T): NextRequest =>
  asReq(new Request('http://localhost/api/anchors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));

const jpeg = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 180 } } }).jpeg().toBuffer();

const upload = async (): Promise<{ id: number }> => {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(await jpeg(700, 500))], 'photo.jpg', { type: 'image/jpeg' }));
  const res = await UPLOAD(
    asReq(new Request('http://localhost/api/photos', { method: 'POST', body: form })),
    ctx({}),
  );
  return ((await res.json()) as { photo: { id: number } }).photo;
};

const preprocess = async (photoId: number): Promise<{ id: number }> => {
  const res = await PREPROCESS(
    asReq(new Request('http://localhost/x', { method: 'POST' })),
    ctx({ id: String(photoId) }),
  );
  return ((await res.json()) as { photo: { id: number } }).photo;
};

const createAnchor = (payload: unknown): Promise<Response> =>
  POST(body(new Request('http://localhost/api/anchors', { method: 'POST' }), payload), ctx({}));

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code;

const auditCount = (action: string): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?').get(action) as { n: number }).n;

describe('POST /api/anchors', () => {
  it('202 + 通过 anchorSchema 的 queued 行；缺省 preprocessedPhotoId 时自动预处理；写一条 anchor.extract 审计', async () => {
    const photo = await upload();
    const before = auditCount('anchor.extract');

    const res = await createAnchor({ photoIds: [photo.id] });

    expect(res.status).toBe(202);
    const anchor = anchorSchema.parse(((await res.json()) as { anchor: unknown }).anchor);
    expect(anchor.status).toBe('queued');
    expect(anchor.attempt).toBe(0);
    expect(anchor.anchorText).toBeNull();
    expect(anchor.features).toBeNull();
    expect(anchor.promptVersion).toBe('anchor-v1');
    expect(anchor.sourcePhotos.map((p) => p.id)).toEqual([photo.id]);
    expect(anchor.preprocessedPhoto?.kind).toBe('preprocessed');
    expect(anchor.preprocessedPhoto?.id).toBeGreaterThan(photo.id);
    expect(auditCount('anchor.extract')).toBe(before + 1);
  });

  it('photoIds 为空 / 6 张以上 → 400 INVALID_PARAM', async () => {
    expect(await errorCode(await createAnchor({ photoIds: [] }))).toBe('INVALID_PARAM');
    const many = { photoIds: [1, 2, 3, 4, 5, 6] };
    expect((await createAnchor(many)).status).toBe(400);
    expect(await errorCode(await createAnchor(many))).toBe('INVALID_PARAM');
  });

  it('SEC-06：kind=generated 的照片 → 400 INVALID_PARAM（防链式自举）', async () => {
    const key = buildKey(1, 'png');
    const file = await getStorage().save(key, await jpeg(120, 120));
    const generated = insertPhoto({
      userId: 1,
      kind: 'generated',
      storageKey: key,
      mime: 'image/png',
      bytes: file.bytes,
      width: 120,
      height: 120,
      sha256: 'f'.repeat(64),
      sourcePhotoId: null,
      qualityJson: null,
      createdAt: nowIso(),
    });

    const res = await createAnchor({ photoIds: [generated.id] });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('INVALID_PARAM');
  });

  it('他人照片 / 不存在的照片 → 404 NOT_FOUND（不返回 403）', async () => {
    const photo = await upload();
    const row = getDb().prepare('UPDATE photos SET user_id = 2 WHERE id = ?').run(photo.id);
    expect(row.changes).toBe(1);
    expect((await createAnchor({ photoIds: [photo.id] })).status).toBe(404);
    expect(await errorCode(await createAnchor({ photoIds: [photo.id] }))).toBe('NOT_FOUND');
    expect((await createAnchor({ photoIds: [999999] })).status).toBe(404);
  });
});

describe('GET /api/anchors/:id', () => {
  it('200 + anchorSchema；不存在 → 404 ANCHOR_NOT_FOUND；未成功时两个产物字段为 null', async () => {
    const photo = await upload();
    const created = anchorSchema.parse(
      ((await (await createAnchor({ photoIds: [photo.id] })).json()) as { anchor: unknown }).anchor,
    );

    const res = await GET(asReq(new Request('http://localhost/x')), ctx({ id: String(created.id) }));
    expect(res.status).toBe(200);
    const anchor = anchorSchema.parse(((await res.json()) as { anchor: unknown }).anchor);
    expect(anchor.id).toBe(created.id);
    expect(anchor.anchorText).toBeNull();
    expect(anchor.features).toBeNull();
    expect(anchor.error).toBeNull();

    const missing = await GET(asReq(new Request('http://localhost/x')), ctx({ id: '999999' }));
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('ANCHOR_NOT_FOUND');
  });
});

describe('POST /api/anchors/:id/retry', () => {
  it('202 新行：attempt = 旧 + 1，继承 inputPhotoIds / preprocessedPhotoId，旧行不被覆盖', async () => {
    const photo = await upload();
    const created = anchorSchema.parse(
      ((await (await createAnchor({ photoIds: [photo.id] })).json()) as { anchor: unknown }).anchor,
    );

    const res = await RETRY(asReq(new Request('http://localhost/x', { method: 'POST' })), ctx({ id: String(created.id) }));
    expect(res.status).toBe(202);
    const retried = anchorSchema.parse(((await res.json()) as { anchor: unknown }).anchor);
    expect(retried.id).not.toBe(created.id);
    expect(retried.attempt).toBe(1);
    expect(retried.status).toBe('queued');
    expect(retried.sourcePhotos.map((p) => p.id)).toEqual(created.sourcePhotos.map((p) => p.id));
    expect(retried.preprocessedPhoto?.id).toBe(created.preprocessedPhoto?.id);

    const old = anchorSchema.parse(
      ((await (await GET(asReq(new Request('http://localhost/x')), ctx({ id: String(created.id) }))).json()) as {
        anchor: unknown;
      }).anchor,
    );
    expect(old.attempt).toBe(0);
    expect(old.status).toBe('queued');
  });

  it('不存在的锚点 → 404 ANCHOR_NOT_FOUND', async () => {
    const res = await RETRY(asReq(new Request('http://localhost/x', { method: 'POST' })), ctx({ id: '999999' }));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('ANCHOR_NOT_FOUND');
  });
});

describe('低质量样本回放（M03 §6.1 / §8）', () => {
  it('回放 anchor-extract-fail.json 的 quality → GET 返回 failed + ANCHOR_LOW_QUALITY + quality', async () => {
    const failFixture = readFixture<{ quality: unknown }>('ark/anchor-extract-fail.json');
    const quality = qualitySchema.parse(failFixture.quality);
    const photo = await upload();
    const preprocessed = await preprocess(photo.id);
    getDb()
      .prepare('UPDATE photos SET quality_json = ? WHERE id = ?')
      .run(JSON.stringify(quality), preprocessed.id);

    const created = anchorSchema.parse(
      ((await (
        await createAnchor({ photoIds: [photo.id], preprocessedPhotoId: preprocessed.id })
      ).json()) as { anchor: unknown }).anchor,
    );

    await anchorExtractHandler({ anchorId: created.id });

    const res = await GET(asReq(new Request('http://localhost/x')), ctx({ id: String(created.id) }));
    const anchor = anchorSchema.parse(((await res.json()) as { anchor: unknown }).anchor);
    expect(anchor.status).toBe('failed');
    expect(anchor.error?.code).toBe('ANCHOR_LOW_QUALITY');
    expect(anchor.quality).toEqual(quality);
    expect(anchor.anchorText).toBeNull();
    expect(anchor.features).toBeNull();
    expect(anchor.finishedAt).not.toBeNull();
  });
});
