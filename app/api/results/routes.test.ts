import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { generationResultSchema } from '../../../src/shared/types';
import { closeDb, getDb } from '../../../src/server/db/connection';
import { runMigrations } from '../../../src/server/db/migrate';
import { runSeed } from '../../../src/server/db/seed';
import { resetStorage } from '../../../src/server/storage';
import { insertPhoto } from '../../../src/server/db/repositories/photos';
import { insert as insertAnchor } from '../../../src/server/db/repositories/anchors';
import { insert as insertGeneration, insertResult } from '../../../src/server/db/repositories/generations';
import { nowIso } from '../../../src/server/domain/time';
import { SID_COOKIE, createSession } from '../../../src/server/auth/session';
import { POST } from './[id]/feedback/route';

/**
 * `POST /api/results/:id/feedback`（`docs/prd/spec/03-接口契约.md` §3.5、`tickets/T13`）：
 * 写入 `user_feedback`、响应走 shared 的 zod schema、归属 404、非法取值 400。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-feedback-'));
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
const asReq = (body: unknown): NextRequest => {
  sid ??= createSession(1).token;
  const req = new Request('http://localhost/api/results/1/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `${SID_COOKIE}=${sid}` },
    body: JSON.stringify(body),
  });
  return req as unknown as NextRequest;
};

const makeResult = (): { resultId: number; userId: number } => {
  const photo = insertPhoto({
    userId: 1,
    kind: 'generated',
    storageKey: 'u1/fb.jpg',
    mime: 'image/jpeg',
    bytes: 1,
    width: 10,
    height: 10,
    sha256: 'f'.repeat(64),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  });
  const anchorId = insertAnchor({
    userId: 1,
    inputPhotoIds: [photo.id],
    preprocessedPhotoId: null,
    status: 'succeeded',
    attempt: 0,
    model: 'm',
    promptVersion: 'v1',
    quality: null,
    createdAt: nowIso(),
  }).id;
  const generationId = insertGeneration({
    userId: 1,
    anchorId,
    eraCode: 'E2',
    sceneId: 1,
    profileId: null,
    referencePhotoIds: [],
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
    createdAt: nowIso(),
  }).id;
  insertResult({ generationId, photoId: photo.id, ordinal: 0, seed: null, eraCheck: null, ageDelta: null, createdAt: nowIso() });
  const row = getDb().prepare('SELECT id FROM generation_results WHERE generation_id = ?').get(generationId) as { id: number };
  return { resultId: row.id, userId: 1 };
};

describe('POST /api/results/:id/feedback', () => {
  it('200 且通过 generationResultSchema；写入 -2（不像他）并读回', async () => {
    const { resultId } = makeResult();
    const res = await POST(asReq({ feedback: -2 }), { params: Promise.resolve({ id: String(resultId) }) });
    expect(res.status).toBe(200);
    const body = generationResultSchema.parse(((await res.json()) as { result: unknown }).result);
    expect(body.userFeedback).toBe(-2);
    expect(
      (getDb().prepare('SELECT user_feedback AS f FROM generation_results WHERE id = ?').get(resultId) as { f: number }).f,
    ).toBe(-2);
  });

  it('null 清除反馈；非法取值 → 400 INVALID_PARAM', async () => {
    const { resultId } = makeResult();
    const cleared = await POST(asReq({ feedback: null }), { params: Promise.resolve({ id: String(resultId) }) });
    expect(generationResultSchema.parse(((await cleared.json()) as { result: unknown }).result).userFeedback).toBeNull();

    const bad = await POST(asReq({ feedback: 5 }), { params: Promise.resolve({ id: String(resultId) }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_PARAM');
  });

  it('不属于当前用户的结果 → 404 NOT_FOUND', async () => {
    const { resultId } = makeResult();
    getDb().prepare('UPDATE generations SET user_id = 2 WHERE id = (SELECT generation_id FROM generation_results WHERE id = ?)').run(resultId);
    const res = await POST(asReq({ feedback: 1 }), { params: Promise.resolve({ id: String(resultId) }) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});
