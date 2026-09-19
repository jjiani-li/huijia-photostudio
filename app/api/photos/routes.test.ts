import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { photoSchema } from '../../../src/shared/types';
import { closeDb } from '../../../src/server/db/connection';
import { runMigrations } from '../../../src/server/db/migrate';
import { runSeed } from '../../../src/server/db/seed';
import { buildKey, getStorage, resetStorage } from '../../../src/server/storage';
import { insertPhoto } from '../../../src/server/db/repositories/photos';
import { nowIso } from '../../../src/server/domain/time';
import { POST } from './route';
import { DELETE } from './[id]/route';
import { GET } from './[id]/file/route';

/**
 * 端点层断言：`API-02`（响应形状走 `src/shared/types.ts` 的 zod schema）、
 * `API-04`（不存在 / 不可达 → 404，不回 403）、`?w=` 越界 → 400、响应头与删除幂等（M01 §9 用例 8/9）。
 * 注：`API-03`（未登录 401）在 M1/M2 的鉴权桩（`tickets/T12` 交付真实会话前）不可达。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-api-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  process.env.STORAGE_DIR = path.join(tmpDir, 'storage');
  closeDb();
  resetStorage();
  runMigrations();
  runSeed();
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

const upload = async (buffer: Buffer, type = 'image/jpeg', name = 'photo.jpg'): Promise<Response> => {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buffer)], name, { type }));
  return POST(asReq(new Request('http://localhost/api/photos', { method: 'POST', body: form })), ctx({}));
};

const jpeg = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 180 } } }).jpeg().toBuffer();

describe('API-02 · POST /api/photos 响应形状', () => {
  it('201 且 photo 通过 shared 的 photoSchema', async () => {
    const res = await upload(await jpeg(300, 200));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { photo: unknown };
    expect(() => photoSchema.parse(body.photo)).not.toThrow();
    const photo = photoSchema.parse(body.photo);
    expect(photo.url).toBe(`/api/photos/${photo.id}/file`);
    expect(photo.kind).toBe('original');
    expect(photo.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('缺少 file 字段 → 400 INVALID_PARAM', async () => {
    const form = new FormData();
    form.set('other', 'x');
    const res = await POST(
      asReq(new Request('http://localhost/api/photos', { method: 'POST', body: form })),
      ctx({}),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_PARAM');
  });
});

describe('API-04 · 取不到就 404', () => {
  it('不存在的照片 → 404 NOT_FOUND', async () => {
    const res = await GET(asReq(new Request('http://localhost/api/photos/999999/file')), ctx({ id: '999999' }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

describe('?w= 取值域', () => {
  it('越界 / 非整数 → 400 INVALID_PARAM', async () => {
    for (const w of ['15', '2049', 'abc', '1.5']) {
      const res = await GET(
        asReq(new Request(`http://localhost/api/photos/1/file?w=${w}`)),
        ctx({ id: '1' }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_PARAM');
    }
  });
});

describe('响应头与删除幂等', () => {
  it('kind=generated 带 X-AIGC-Generated；original 不带；均带 Cache-Control', async () => {
    const original = photoSchema.parse(
      ((await (await upload(await jpeg(120, 120))).json()) as { photo: unknown }).photo,
    );
    const originalRes = await GET(
      asReq(new Request(`http://localhost/api/photos/${original.id}/file`)),
      ctx({ id: String(original.id) }),
    );
    expect(originalRes.headers.get('X-AIGC-Generated')).toBeNull();
    expect(originalRes.headers.get('Cache-Control')).toBe('private, max-age=3600');
    expect(originalRes.headers.get('Content-Type')).toBe('image/jpeg');

    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toBuffer();
    const key = buildKey(1, 'png');
    const saved = await getStorage().save(key, png);
    const generated = insertPhoto({
      userId: 1,
      kind: 'generated',
      storageKey: key,
      mime: 'image/png',
      bytes: saved.bytes,
      width: 64,
      height: 64,
      sha256: 'a'.repeat(64),
      sourcePhotoId: null,
      qualityJson: null,
      createdAt: nowIso(),
    });
    const generatedRes = await GET(
      asReq(new Request(`http://localhost/api/photos/${generated.id}/file`)),
      ctx({ id: String(generated.id) }),
    );
    expect(generatedRes.headers.get('X-AIGC-Generated')).toBe('true');
    expect(generatedRes.headers.get('Cache-Control')).toBe('private, max-age=3600');
  });

  it('连续两次 DELETE → 均 200，第二次 cascaded 全 0', async () => {
    const photo = photoSchema.parse(
      ((await (await upload(await jpeg(110, 110))).json()) as { photo: unknown }).photo,
    );
    const first = await DELETE(asReq(new Request('http://localhost/x', { method: 'DELETE' })), ctx({ id: String(photo.id) }));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { cascaded: object }).cascaded).toEqual({
      preprocessed: 0,
      anchors: 0,
      generations: 0,
      results: 0,
    });
    const second = await DELETE(asReq(new Request('http://localhost/x', { method: 'DELETE' })), ctx({ id: String(photo.id) }));
    expect(second.status).toBe(200);
  });
});
