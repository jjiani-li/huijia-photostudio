import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { insert, type InsertAnchorInput } from '../db/repositories/anchors';
import { ensureActive } from '../db/repositories/consents';
import { getEra, getProfile, getScene, type EraRecord } from '../db/repositories/config';
import { updateStatus } from '../db/repositories/generations';
import { insertPhoto } from '../db/repositories/photos';
import { getDay } from '../db/repositories/usage';
import { buildPrompt } from '../prompt/build';
import { nowIso, dayKey } from './time';
import { AppError, ERROR_MESSAGE } from './errors';
import { revokeConsents } from './anchorService';
import {
  assertAnchorGeneratable,
  buildGenerationDraft,
  createGeneration,
  readGenerationForUser,
  retryGeneration,
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

// ── createGeneration / retryGeneration（modules/M06 §5.1–§5.2、§5.6、§5.7）─────────────────

/** 拼装用的锚点文本（长度足够、不含否定词与美化词）。 */
const ANCHOR_TEXT = '一个老年男性的身份锚点描述，五官与发际线都写清楚，长度足够用于拼装';

const generationCount = (): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM generations').get() as { n: number }).n;

const setAnchorText = (id: number, text: string | null = ANCHOR_TEXT): void => {
  getDb().prepare('UPDATE identity_anchors SET anchor_text = ? WHERE id = ?').run(text, id);
};

/** 造一张 `kind='preprocessed'` 照片，供 `reference_photo_ids`（`E2E-04`）使用。 */
const makePreprocessedPhoto = (): number =>
  insertPhoto({
    userId: 1,
    kind: 'preprocessed',
    storageKey: `u1/pre-${Math.random().toString(16).slice(2)}.jpg`,
    mime: 'image/jpeg',
    bytes: 1024,
    width: 1600,
    height: 1200,
    sha256: 'c'.repeat(64),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  }).id;

/** 已确认 + 有 `photo_usage` + 有 `anchor_text` 的锚点：8 步序列里只剩额度与非终态待检。 */
const readyAnchor = (over: Partial<InsertAnchorInput> = {}): number => {
  const id = makeAnchor(over);
  confirmRow(id, nowIso());
  ensureActive({ userId: 1, anchorId: id, scope: 'photo_usage', agreedAt: nowIso() });
  setAnchorText(id);
  return id;
};

/** 每个用例前清掉上次留下的生成行与额度计数（同一临时库内互不干扰）。 */
beforeEach(() => {
  getDb().prepare('DELETE FROM generation_results').run();
  getDb().prepare('DELETE FROM generations').run();
  getDb().prepare('DELETE FROM usage_counters').run();
});

const create = (anchorId: number, count = 2, over: Partial<{ userId: number; eraCode: string; sceneId: number }> = {}) =>
  createGeneration({ userId: 1, anchorId, eraCode: 'E2', sceneId: 1, count, ...over });

describe('createGeneration 的 8 步校验序列（modules/M06 §5.1，顺序即契约）', () => {
  it('第 1 步先于第 5 步：未实名 → REALNAME_REQUIRED（锚点此时也未确认）', () => {
    const id = makeAnchor();
    getDb().prepare('UPDATE users SET verified_at = NULL WHERE id = 1').run();
    try {
      expect(codeOf(() => create(id))).toBe('REALNAME_REQUIRED');
    } finally {
      getDb().prepare('UPDATE users SET verified_at = ? WHERE id = 1').run('2026-01-01T00:00:00Z');
    }
  });

  it('第 2 步：count ∉ {2,3,4} → INVALID_PARAM', () => {
    const id = readyAnchor();
    expect(codeOf(() => create(id, 1))).toBe('INVALID_PARAM');
    expect(codeOf(() => create(id, 5))).toBe('INVALID_PARAM');
  });

  it('第 3 步：eraCode / sceneId 不存在或未启用 → INVALID_PARAM', () => {
    const id = readyAnchor();
    expect(codeOf(() => create(id, 2, { eraCode: 'E9' }))).toBe('INVALID_PARAM');
    expect(codeOf(() => create(id, 2, { sceneId: 999 }))).toBe('INVALID_PARAM');
  });

  it('第 4 步失败时不报第 5 步：他人锚点（且未确认）→ ANCHOR_NOT_FOUND', () => {
    const id = readyAnchor({ status: 'failed' });
    getDb().prepare('UPDATE identity_anchors SET user_id = 2 WHERE id = ?').run(id);
    expect(codeOf(() => create(id))).toBe('ANCHOR_NOT_FOUND');
  });

  it('第 5 步：status != succeeded / confirmed_by_user != 1 → ANCHOR_NOT_CONFIRMED', () => {
    const failed = readyAnchor({ status: 'failed' });
    expect(codeOf(() => create(failed))).toBe('ANCHOR_NOT_CONFIRMED');
    const unconfirmed = makeAnchor();
    expect(codeOf(() => create(unconfirmed))).toBe('ANCHOR_NOT_CONFIRMED');
  });

  it('anchor_text 为空（不变量被破坏）→ ANCHOR_NOT_CONFIRMED，不产生 generations 行', () => {
    const id = readyAnchor();
    setAnchorText(id, null);
    const before = generationCount();
    expect(codeOf(() => create(id))).toBe('ANCHOR_NOT_CONFIRMED');
    expect(generationCount()).toBe(before);
  });

  it('第 5 步（anchor_text 空）先于第 7 步：额度同样不足时报 ANCHOR_NOT_CONFIRMED，不报 QUOTA_EXCEEDED', () => {
    const id = readyAnchor();
    setAnchorText(id, null);
    getDb().prepare('UPDATE users SET daily_image_quota = 1 WHERE id = 1').run();
    try {
      expect(codeOf(() => create(id, 2))).toBe('ANCHOR_NOT_CONFIRMED');
    } finally {
      getDb().prepare('UPDATE users SET daily_image_quota = 20 WHERE id = 1').run();
    }
  });

  it('第 6 步：photo_usage 不存在或已吊销 → CONSENT_REQUIRED', () => {
    const id = readyAnchor();
    expect(revokeConsents(1, 'photo_usage')).toBeGreaterThan(0);
    expect(codeOf(() => create(id))).toBe('CONSENT_REQUIRED');
  });

  it('SEC-04 第 7 步：额度不足 → QUOTA_EXCEEDED，且不产生 generations 行', () => {
    const id = readyAnchor();
    getDb().prepare('UPDATE users SET daily_image_quota = 1 WHERE id = 1').run();
    const before = generationCount();
    try {
      expect(codeOf(() => create(id, 2))).toBe('QUOTA_EXCEEDED');
      expect(generationCount()).toBe(before);
      expect(getDay(1, dayKey()).images).toBe(0);
    } finally {
      getDb().prepare('UPDATE users SET daily_image_quota = 20 WHERE id = 1').run();
    }
  });

  it('SEC-05 第 8 步：已有非终态任务 → GENERATION_IN_PROGRESS，且不产生第二行', () => {
    const id = readyAnchor();
    const first = create(id, 2);
    const before = generationCount();
    expect(codeOf(() => create(id, 2))).toBe('GENERATION_IN_PROGRESS');
    expect(generationCount()).toBe(before);
    expect(getDay(1, dayKey()).images).toBe(2);
    expect(first.status).toBe('queued');
  });

  it('错误码顺序：额度不足时不报 GENERATION_IN_PROGRESS（第 7 步先于第 8 步）', () => {
    const id = readyAnchor();
    create(id, 2); // 留下一个非终态行
    getDb().prepare('UPDATE users SET daily_image_quota = 1 WHERE id = 1').run();
    try {
      expect(codeOf(() => create(id, 2))).toBe('QUOTA_EXCEEDED');
    } finally {
      getDb().prepare('UPDATE users SET daily_image_quota = 20 WHERE id = 1').run();
    }
  });
});

describe('createGeneration 的副作用与形状（E2E-03 / E2E-04 / E2E-08）', () => {
  it('单事务入队：generations +1、usage.images +count、prompt 与 prompt_hash 取自 buildPrompt', () => {
    const photoId = makePreprocessedPhoto();
    const id = readyAnchor({ preprocessedPhotoId: photoId });
    const before = generationCount();
    const record = create(id, 3);

    expect(generationCount()).toBe(before + 1);
    expect(getDay(1, dayKey())).toEqual({ userId: 1, day: dayKey(), generations: 1, images: 3 });

    const eraRecord = getEra('E2');
    const sceneRecord = getScene(1);
    if (eraRecord === null || sceneRecord === null) throw new Error('种子缺 E2 / 场景 1');
    const expected = buildPrompt({
      anchorText: ANCHOR_TEXT,
      era: eraRecord,
      scene: sceneRecord,
      profile: getProfile('E2', 1),
    });
    expect(record.prompt).toBe(expected.prompt);
    expect(record.promptHash).toBe(expected.promptHash);
    expect(record.status).toBe('queued');
    expect(record.attempt).toBe(0);
    expect(record.requestedCount).toBe(3);
    expect(record.params).toEqual({
      size: eraRecord.defaultSize,
      outputFormat: 'png',
      watermark: false,
      provider: 'mock',
    });
  });

  it('E2E-04：reference_photo_ids 恰 1 个元素，且它指向 kind=preprocessed 的照片', () => {
    const photoId = makePreprocessedPhoto();
    const id = readyAnchor({ preprocessedPhotoId: photoId });
    const record = create(id, 2);

    expect(record.referencePhotoIds).toEqual([photoId]);
    const photo = getDb().prepare('SELECT kind FROM photos WHERE id = ?').get(photoId) as { kind: string };
    expect(photo.kind).toBe('preprocessed');
  });

  it('preprocessed_photo_id 为 NULL 时 reference_photo_ids 为空数组', () => {
    const id = readyAnchor();
    expect(create(id, 2).referencePhotoIds).toEqual([]);
  });

  it('audit_logs 写一行 generation.create（target = generation:<id>）', () => {
    const id = readyAnchor();
    const record = create(id, 2);
    const n = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'generation.create' AND target = ?")
        .get(`generation:${record.id}`) as { n: number }
    ).n;
    expect(n).toBe(1);
  });
});

describe('readGenerationForUser / toGenerationDto（spec/03 §3.5、§4）', () => {
  it('DTO 形状：eraName / sceneName 来自 config，results 为空数组，params 四项', () => {
    const id = readyAnchor({ preprocessedPhotoId: makePreprocessedPhoto() });
    const record = create(id, 2);
    const dto = readGenerationForUser(1, record.id);

    expect(Object.keys(dto)).toEqual([
      'id',
      'status',
      'eraCode',
      'eraName',
      'sceneId',
      'sceneName',
      'requestedCount',
      'attempt',
      'prompt',
      'templateVersion',
      'params',
      'error',
      'createdAt',
      'finishedAt',
      'results',
    ]);
    expect(dto.eraName).toBe(getEra('E2')?.name);
    expect(dto.sceneName).toBe(getScene(1)?.name);
    expect(dto.results).toEqual([]);
    expect(dto.error).toBeNull();
  });

  it('error.message 取 spec/03 §5 的文案，**不透出**库里的上游原文', () => {
    const id = readyAnchor();
    const record = create(id, 2);
    getDb()
      .prepare("UPDATE generations SET status='failed', error_code='PROVIDER_ERROR', error_message=? WHERE id=?")
      .run('upstream raw: ModelNotOpen endpoint ep-123', record.id);

    const dto = readGenerationForUser(1, record.id);
    expect(dto.error).toEqual({ code: 'PROVIDER_ERROR', message: ERROR_MESSAGE.PROVIDER_ERROR });
    expect(JSON.stringify(dto)).not.toContain('ModelNotOpen');
  });

  it('别人的任务 / 不存在 → NOT_FOUND', () => {
    const id = readyAnchor();
    const record = create(id, 2);
    expect(codeOf(() => readGenerationForUser(2, record.id))).toBe('NOT_FOUND');
    expect(codeOf(() => readGenerationForUser(1, 999999))).toBe('NOT_FOUND');
  });
});

describe('retryGeneration 的新建行语义（modules/M06 §5.7，E2E-09）', () => {
  it('E2E-09：新行继承设定、attempt=0，旧行与其结果行逐列不变', () => {
    const id = readyAnchor({ preprocessedPhotoId: makePreprocessedPhoto() });
    const first = create(id, 2);
    getDb().prepare("UPDATE generations SET status='succeeded', finished_at=? WHERE id=?").run(nowIso(), first.id);
    const before = getDb().prepare('SELECT * FROM generations WHERE id = ?').get(first.id);

    const second = retryGeneration({ userId: 1, generationId: first.id });

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('queued');
    expect(second.attempt).toBe(0);
    expect(second.anchorId).toBe(first.anchorId);
    expect(second.eraCode).toBe(first.eraCode);
    expect(second.sceneId).toBe(first.sceneId);
    expect(second.requestedCount).toBe(first.requestedCount);
    expect(second.prompt).toBe(first.prompt);
    expect(getDb().prepare('SELECT * FROM generations WHERE id = ?').get(first.id)).toEqual(before);
    expect(generationCount()).toBe(2);
  });

  it('原任务 queued / running → GENERATION_IN_PROGRESS', () => {
    const id = readyAnchor();
    const first = create(id, 2);
    expect(codeOf(() => retryGeneration({ userId: 1, generationId: first.id }))).toBe('GENERATION_IN_PROGRESS');

    updateStatus({
      id: first.id,
      status: 'running',
      attempt: 1,
      errorCode: null,
      errorMessage: null,
      startedAt: nowIso(),
      finishedAt: null,
    });
    expect(codeOf(() => retryGeneration({ userId: 1, generationId: first.id }))).toBe('GENERATION_IN_PROGRESS');
  });

  it('partial / failed 也可重试；别人的任务 / 不存在 → NOT_FOUND', () => {
    const id = readyAnchor();
    for (const status of ['partial', 'failed'] as const) {
      getDb().prepare('DELETE FROM generations').run();
      const first = create(id, 2);
      getDb()
        .prepare('UPDATE generations SET status = ?, finished_at = ? WHERE id = ?')
        .run(status, nowIso(), first.id);
      expect(retryGeneration({ userId: 1, generationId: first.id }).status).toBe('queued');
      expect(codeOf(() => retryGeneration({ userId: 2, generationId: first.id }))).toBe('NOT_FOUND');
    }
  });

  it('params_json 由旧行继承，不按当前环境重算（spec/03-接口契约.md §3.5）', () => {
    const id = readyAnchor();
    const first = create(id, 2);
    const inherited = { size: '2048x2048', outputFormat: 'png', watermark: true, provider: 'real' } as const;
    getDb()
      .prepare("UPDATE generations SET params_json = ?, status = 'succeeded' WHERE id = ?")
      .run(JSON.stringify(inherited), first.id);

    const second = retryGeneration({ userId: 1, generationId: first.id });
    expect(second.params).toEqual(inherited);
  });
});
