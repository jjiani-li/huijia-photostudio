import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { insert, type InsertAnchorInput } from '../db/repositories/anchors';
import { ensureActive } from '../db/repositories/consents';
import { nowIso } from './time';
import { AppError } from './errors';
import { revokeConsents } from './anchorService';
import { assertAnchorGeneratable } from './generationService';

/**
 * `assertAnchorGeneratable` 的单元形态（`docs/prd/modules/M04-身份确认与授权.md` §8.1 第 ⑥ 条）：
 * `SEC-01`（未确认 → 409，不得是 403）与 `SEC-03`（吊销 `photo_usage` → 403）。
 * 端到端形态（`POST /api/generations`）待 `tickets/T09` 的完整序列落成后转绿。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-generation-guard-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  process.env.STORAGE_DIR = path.join(tmpDir, 'storage');
  closeDb();
  runMigrations();
  runSeed();
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.STORAGE_DIR;
});

const makeAnchor = (over: Partial<InsertAnchorInput> = {}): number =>
  insert({
    userId: 1,
    inputPhotoIds: [1],
    preprocessedPhotoId: null,
    status: 'succeeded',
    attempt: 0,
    model: 'anchor-model',
    promptVersion: 'anchor-v1',
    quality: null,
    createdAt: nowIso(),
    ...over,
  }).id;

const confirmRow = (id: number, at: string): void => {
  getDb().prepare('UPDATE identity_anchors SET confirmed_by_user = 1, confirmed_at = ? WHERE id = ?').run(at, id);
};

/** 捕获 `assertAnchorGeneratable` 抛出的错误码；未抛错返回 `'NO_THROW'`。 */
const codeOf = (fn: () => void): string => {
  try {
    fn();
    return 'NO_THROW';
  } catch (err) {
    return err instanceof AppError ? err.code : `NON_APP_ERROR:${String(err)}`;
  }
};

describe('assertAnchorGeneratable（M04 §5.3 两步守卫）', () => {
  it('SEC-01：未确认（confirmed_by_user=0）且无任何 consents 行 → ANCHOR_NOT_CONFIRMED（不得是 CONSENT_REQUIRED）', () => {
    const id = makeAnchor();
    expect(codeOf(() => assertAnchorGeneratable(1, id))).toBe('ANCHOR_NOT_CONFIRMED');
  });

  it('锚点非 succeeded（failed）→ ANCHOR_NOT_CONFIRMED', () => {
    const id = makeAnchor({ status: 'failed' });
    confirmRow(id, nowIso());
    expect(codeOf(() => assertAnchorGeneratable(1, id))).toBe('ANCHOR_NOT_CONFIRMED');
  });

  it('已确认但无有效 photo_usage → CONSENT_REQUIRED', () => {
    const id = makeAnchor();
    confirmRow(id, nowIso());
    expect(codeOf(() => assertAnchorGeneratable(1, id))).toBe('CONSENT_REQUIRED');
  });

  it('SEC-03：吊销 photo_usage 后 → CONSENT_REQUIRED，且不产生 generations 行', () => {
    const id = makeAnchor();
    confirmRow(id, nowIso());
    ensureActive({ userId: 1, anchorId: id, scope: 'photo_usage', agreedAt: nowIso() });
    expect(revokeConsents(1, 'photo_usage')).toBe(1);

    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM generations').get() as { n: number }).n;
    expect(codeOf(() => assertAnchorGeneratable(1, id))).toBe('CONSENT_REQUIRED');
    const after = (getDb().prepare('SELECT COUNT(*) AS n FROM generations').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('已确认且有有效 photo_usage → 不抛错', () => {
    const id = makeAnchor();
    confirmRow(id, nowIso());
    ensureActive({ userId: 1, anchorId: id, scope: 'photo_usage', agreedAt: nowIso() });
    expect(codeOf(() => assertAnchorGeneratable(1, id))).toBe('NO_THROW');
  });

  it('不存在 / 他人锚点 → ANCHOR_NOT_FOUND（先于权限，API-04）', () => {
    expect(codeOf(() => assertAnchorGeneratable(1, 999999))).toBe('ANCHOR_NOT_FOUND');
    const id = makeAnchor();
    getDb().prepare('UPDATE identity_anchors SET user_id = 2 WHERE id = ?').run(id);
    expect(codeOf(() => assertAnchorGeneratable(1, id))).toBe('ANCHOR_NOT_FOUND');
  });
});
