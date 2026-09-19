import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { insert, type InsertAnchorInput } from '../db/repositories/anchors';
import { ensureActive } from '../db/repositories/consents';
import { getEra, getProfile, getScene, type EraRecord } from '../db/repositories/config';
import { nowIso } from './time';
import { AppError } from './errors';
import { revokeConsents } from './anchorService';
import {
  assertAnchorGeneratable,
  buildGenerationDraft,
  type GenerationDraft,
} from './generationService';

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

// ── buildGenerationDraft（modules/M05 §5.2、§5.3）：size 校验与拼装产物落库取值 ──────────────

const era = (over: Partial<EraRecord> = {}): EraRecord => {
  const base = getEra('E2');
  if (base === null) throw new Error('种子缺 E2');
  return { ...base, ...over };
};

const draft = (anchorText: string, eraRecord: EraRecord = era()): GenerationDraft => {
  const scene = getScene(1);
  if (scene === null) throw new Error('种子缺场景 1');
  return buildGenerationDraft({ anchorText, era: eraRecord, scene, profile: getProfile('E2', 1) });
};

describe('buildGenerationDraft（modules/M05 §5.1–§5.3）', () => {
  it('2048x2048 通过；size 原样写入 params，outputFormat=png，provider=mock，watermark=false', () => {
    const result = draft('一个老年男性的身份锚点描述，长度足够用于拼装');
    expect(result.params.size).toBe('2048x2048');
    expect(result.params.outputFormat).toBe('png');
    expect(result.params.provider).toBe('mock');
    expect(result.params.watermark).toBe(false);
  });

  it('template_version=tpl-v1，两个 pack 版本取行值，model 取 ARK_IMAGE_MODEL 默认，prompt/hash 来自 buildPrompt', () => {
    const result = draft('一个老年男性的身份锚点描述，长度足够用于拼装');
    expect(result.templateVersion).toBe('tpl-v1');
    expect(result.eraPackVersion).toBe(era().packVersion);
    expect(result.scenePackVersion).toBe(getScene(1)?.packVersion);
    expect(result.model).toBe('doubao-seedream-5-0-lite-260128');
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.prompt.length).toBeGreaterThan(0);
  });

  it('WATERMARK_DEFAULT=true / PROVIDER=real 时透传', () => {
    process.env.WATERMARK_DEFAULT = 'true';
    process.env.PROVIDER = 'real';
    try {
      const result = draft('一个老年男性的身份锚点描述，长度足够用于拼装');
      expect(result.params.watermark).toBe(true);
      expect(result.params.provider).toBe('real');
    } finally {
      delete process.env.WATERMARK_DEFAULT;
      delete process.env.PROVIDER;
    }
  });

  it('size 低于下限 / 形状非法 → INTERNAL', () => {
    expect(codeOf(() => draft('有效锚点描述文本', era({ defaultSize: '1024x1024' })))).toBe('INTERNAL');
    expect(codeOf(() => draft('有效锚点描述文本', era({ defaultSize: '1000x3686' })))).toBe('INTERNAL');
    expect(codeOf(() => draft('有效锚点描述文本', era({ defaultSize: '2048' })))).toBe('INTERNAL');
  });

  it('anchorText 为空 / 全空白 → ANCHOR_NOT_CONFIRMED（不抛 INTERNAL）', () => {
    expect(codeOf(() => draft(''))).toBe('ANCHOR_NOT_CONFIRMED');
    expect(codeOf(() => draft('   '))).toBe('ANCHOR_NOT_CONFIRMED');
  });
});
