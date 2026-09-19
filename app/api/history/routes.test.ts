import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { historyListSchema } from '../../../src/shared/types';
import { closeDb, getDb } from '../../../src/server/db/connection';
import { runMigrations } from '../../../src/server/db/migrate';
import { runSeed } from '../../../src/server/db/seed';
import { resetStorage } from '../../../src/server/storage';
import { insertPhoto } from '../../../src/server/db/repositories/photos';
import { insert as insertAnchor } from '../../../src/server/db/repositories/anchors';
import { insert as insertGeneration, insertResult } from '../../../src/server/db/repositories/generations';
import { nowIso } from '../../../src/server/domain/time';
import { SID_COOKIE, createSession } from '../../../src/server/auth/session';
import { GET } from './route';
import { GET as listPhotos } from '../photos/route';

/**
 * `tickets/T13` 的端点层断言（`docs/prd/spec/03-接口契约.md` §3.2、§3.6）：
 * `HistoryItem` 形状（走 shared 的 zod schema）、游标往返与非法游标、
 * **两个游标互不通用**（§4 第 5 条）、全部输入图软删后锚点从历史消失（`DEL-01` 的口径）。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-history-'));
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

let sid: string | null = null;
const asReq = (url: string): NextRequest => {
  sid ??= createSession(1).token;
  const req = new Request(url);
  req.headers.set('cookie', `${SID_COOKIE}=${sid}`);
  return req as unknown as NextRequest;
};

const insertPhotoRow = (over: Partial<Parameters<typeof insertPhoto>[0]> = {}): number =>
  insertPhoto({
    userId: 1,
    kind: 'original',
    storageKey: `u1/${Math.random()}.jpg`,
    mime: 'image/jpeg',
    bytes: 10,
    width: 100,
    height: 100,
    sha256: Math.random().toString(16).slice(2).padEnd(64, '0'),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
    ...over,
  }).id;

const makeHistoryAnchor = (createdAt = nowIso()): { anchorId: number; original: number } => {
  const original = insertPhotoRow({ kind: 'original' });
  const preprocessed = insertPhotoRow({ kind: 'preprocessed', sourcePhotoId: original });
  const anchorId = insertAnchor({
    userId: 1,
    inputPhotoIds: [original],
    preprocessedPhotoId: preprocessed,
    status: 'succeeded',
    attempt: 0,
    model: 'm',
    promptVersion: 'v1',
    quality: null,
    createdAt,
  }).id;
  getDb().prepare('UPDATE identity_anchors SET anchor_text = ? WHERE id = ?').run('锚点文本', anchorId);
  const generationId = insertGeneration({
    userId: 1,
    anchorId,
    eraCode: 'E2',
    sceneId: 1,
    profileId: null,
    referencePhotoIds: [preprocessed],
    prompt: 'p',
    promptHash: 'a'.repeat(64),
    templateVersion: 'tpl',
    eraPackVersion: 'e',
    scenePackVersion: 's',
    model: 'm',
    params: { size: '2048x2048', outputFormat: 'png', watermark: false, provider: 'mock' },
    requestedCount: 1,
    status: 'succeeded',
    attempt: 0,
    createdAt,
  }).id;
  const generated = insertPhotoRow({ kind: 'generated' });
  insertResult({ generationId, photoId: generated, ordinal: 0, seed: null, eraCheck: null, ageDelta: null, createdAt });
  return { anchorId, original };
};

const readHistory = async (query = ''): Promise<Response> =>
  GET(asReq(`http://localhost/api/history${query}`), { params: Promise.resolve({}) });

describe('GET /api/history · 形状与游标', () => {
  it('200 且通过 historyListSchema；照片 url 带 ?w=400', async () => {
    makeHistoryAnchor();
    const res = await readHistory();
    expect(res.status).toBe(200);
    const body = historyListSchema.parse(await res.json());
    const item = body.items.at(-1);
    expect(item).toBeDefined();
    expect(item?.anchorText).toBe('锚点文本');
    expect(item?.sourcePhoto.url).toContain('?w=400');
    expect(item?.generations.length).toBe(1);
    expect(item?.generations[0]?.results[0]?.url).toContain('?w=400');
  });

  it('limit=1 → 有 nextCursor；回传该游标取下一页且不重复', async () => {
    makeHistoryAnchor(); // 保证至少有两条，才能出现下一页
    const first = historyListSchema.parse(await (await readHistory('?limit=1')).json());
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = historyListSchema.parse(
      await (await readHistory(`?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)).json(),
    );
    expect(second.items[0]?.anchorId).not.toBe(first.items[0]?.anchorId);
  });

  it('非法 cursor / 越界 limit → 400 INVALID_PARAM', async () => {
    for (const query of ['?cursor=not-a-cursor', '?limit=0', '?limit=51']) {
      const res = await readHistory(query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_PARAM');
    }
  });

  it('全部输入图软删后该锚点从历史消失', async () => {
    const { anchorId, original } = makeHistoryAnchor();
    getDb().prepare('UPDATE photos SET deleted_at = ? WHERE id = ?').run(nowIso(), original);
    const body = historyListSchema.parse(await (await readHistory('?limit=50')).json());
    expect(body.items.some((item) => item.anchorId === anchorId)).toBe(false);
  });

  it('每锚点最多返回最近 10 条 generations', async () => {
    const { anchorId } = makeHistoryAnchor();
    const preprocessed = (getDb().prepare('SELECT preprocessed_photo_id AS id FROM identity_anchors WHERE id = ?').get(anchorId) as { id: number }).id;
    for (let i = 0; i < 12; i += 1) {
      insertGeneration({
        userId: 1,
        anchorId,
        eraCode: 'E2',
        sceneId: 1,
        profileId: null,
        referencePhotoIds: [preprocessed],
        prompt: 'p',
        promptHash: 'b'.repeat(64),
        templateVersion: 'tpl',
        eraPackVersion: 'e',
        scenePackVersion: 's',
        model: 'm',
        params: { size: '2048x2048', outputFormat: 'png', watermark: false, provider: 'mock' },
        requestedCount: 1,
        status: 'succeeded',
        attempt: 0,
        createdAt: new Date(Date.now() + i * 1000).toISOString(),
      });
    }
    const body = historyListSchema.parse(await (await readHistory('?limit=50')).json());
    const item = body.items.find((entry) => entry.anchorId === anchorId);
    expect(item?.generations.length).toBe(10);
  });
});

describe('两个游标互不通用（§3.2 / §3.6、§4 第 5 条）', () => {
  it('把 /api/history 的 cursor 传给 /api/photos → 400；反向同理', async () => {
    const historyBody = historyListSchema.parse(await (await readHistory('?limit=1')).json());
    const historyCursor = historyBody.nextCursor ?? '';

    const wrongPhotos = await listPhotos(
      asReq(`http://localhost/api/photos?cursor=${encodeURIComponent(historyCursor)}`),
      { params: Promise.resolve({}) },
    );
    expect(wrongPhotos.status).toBe(400);
    expect(((await wrongPhotos.json()) as { error: { code: string } }).error.code).toBe('INVALID_PARAM');

    // 造两张未呈现的照片，让 /api/photos 能吐出自己的 nextCursor。
    insertPhotoRow();
    insertPhotoRow();
    const photosRes = await listPhotos(asReq('http://localhost/api/photos?limit=1'), { params: Promise.resolve({}) });
    const photosBody = (await photosRes.json()) as { nextCursor: string | null };
    expect(photosBody.nextCursor).not.toBeNull();

    const wrongHistory = await readHistory(`?cursor=${encodeURIComponent(photosBody.nextCursor ?? '')}`);
    expect(wrongHistory.status).toBe(400);
  });
});
