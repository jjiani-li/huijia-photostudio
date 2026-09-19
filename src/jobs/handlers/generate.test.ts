import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArkUpstreamError, getArk, resetArk } from '../../server/ark';
import { closeDb, getDb } from '../../server/db/connection';
import { runMigrations } from '../../server/db/migrate';
import { runSeed } from '../../server/db/seed';
import { insert as insertAnchor } from '../../server/db/repositories/anchors';
import { findById as findGenerationById } from '../../server/db/repositories/generations';
import { insertPhoto } from '../../server/db/repositories/photos';
import { createGeneration } from '../../server/domain/generationService';
import { nowIso } from '../../server/domain/time';
import { buildKey, getStorage, resetStorage } from '../../server/storage';
import { runGenerateJob } from './generate';
import type { EraCheck } from '../../shared/types';

/**
 * 生成 handler 的复核 / 审核接线（`docs/prd/modules/M07-生成后复核与内容审核.md` §5.1）：
 * `ERA-01`（复核判定只标注、不阻断）与 `ERA-02` 的落库形状、以及 `SEC-08` 的 A 层旁证。
 * 纯函数与算术见 `src/server/security/eraReview.test.ts`；B 层 `SEC-08` 见 `scripts/acceptance.ts`。
 *
 * 复核 / 审核的正文用 provider spy 指定，不改 `fixtures/ark/*.json`（避免 vitest 并发写夹具）。
 */
let tmpDir: string;

const ANCHOR_TEXT = '一个老年男性的身份锚点描述，五官与发际线都写清楚，长度足够用于拼装';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-generate-review-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  process.env.STORAGE_DIR = path.join(tmpDir, 'storage');
  process.env.PROVIDER = 'mock';
  closeDb();
  resetStorage();
  resetArk();
  runMigrations();
  runSeed();
  getDb().prepare('UPDATE users SET daily_image_quota = 100000 WHERE id = 1').run();
});

afterAll(() => {
  closeDb();
  resetStorage();
  resetArk();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.STORAGE_DIR;
  delete process.env.PROVIDER;
});

beforeEach(() => {
  getDb().prepare('DELETE FROM generation_results').run();
  getDb().prepare('DELETE FROM generations').run();
  getDb().prepare("DELETE FROM audit_logs WHERE action = 'moderation.reject'").run();
  getDb().prepare('DELETE FROM content_reviews').run();
  vi.restoreAllMocks();
});

/** 让复核回放指定 `EraCheck` 正文（`estimatedAgeRange` 决定 `age_delta`）。 */
const stubEra = (body: { verdict: string; findings?: Array<{ item: string; reason: string }>; estimatedAgeRange?: string | null }) =>
  vi.spyOn(getArk(), 'reviewEra').mockResolvedValue({
    raw: JSON.stringify({ findings: [], estimatedAgeRange: null, ...body }),
    model: 'mock-vision-model',
  });

/** 让审核按阶段回放判定（未指定的阶段一律 `pass`，避免 prompt 阶段被误伤）。 */
const stubSafety = (verdictByStage: Partial<Record<'upload' | 'prompt' | 'result', string>>) =>
  vi.spyOn(getArk(), 'reviewSafety').mockImplementation(async (input) => {
    const verdict = verdictByStage[input.stage] ?? 'pass';
    return {
      raw: JSON.stringify({ verdict, reason: verdict === 'pass' ? null : '样本理由' }),
      model: 'mock-safety-model',
    };
  });

const makeAnchor = async (ageRange: string): Promise<number> => {
  const buffer = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 170, b: 140 } } })
    .png()
    .toBuffer();
  const key = buildKey(1, 'png');
  await getStorage().save(key, buffer);
  const photo = insertPhoto({
    userId: 1,
    kind: 'preprocessed',
    storageKey: key,
    mime: 'image/png',
    bytes: buffer.length,
    width: 64,
    height: 64,
    sha256: `${Date.now()}${Math.random()}`.slice(0, 64),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  });
  const features = {
    gender: '男',
    ageRange,
    hair: '灰白短寸',
    faceShape: '方圆脸',
    forehead: '有横纹',
    eyebrows: '稀疏',
    eyes: '单眼皮',
    nose: '鼻头圆润',
    mouth: '嘴唇偏薄',
    skin: '偏黄',
    distinctive: '无明显痣疤',
    build: '瘦高',
  };
  const anchor = insertAnchor({
    userId: 1,
    inputPhotoIds: [photo.id],
    preprocessedPhotoId: photo.id,
    status: 'succeeded',
    attempt: 0,
    model: 'anchor-model',
    promptVersion: 'anchor-v1',
    quality: null,
    createdAt: nowIso(),
  });
  getDb()
    .prepare(
      `UPDATE identity_anchors SET anchor_text = ?, features_json = ?, confirmed_by_user = 1, confirmed_at = ?
       WHERE id = ?`,
    )
    .run(ANCHOR_TEXT, JSON.stringify(features), nowIso(), anchor.id);
  getDb()
    .prepare("INSERT INTO consents (user_id, scope, anchor_id, agreed_at) VALUES (1, 'photo_usage', ?, ?)")
    .run(anchor.id, nowIso());
  return anchor.id;
};

/** 入队并直调 handler（与 worker 的调用形态一致）。 */
const runOne = async (anchorId: number, count = 3): Promise<number> => {
  const record = await createGeneration({ userId: 1, anchorId, eraCode: 'E2', sceneId: 1, count });
  const stored = findGenerationById(record.id);
  if (stored === null) throw new Error('generation 未落库');
  await runGenerateJob(stored);
  return record.id;
};

const resultsOf = (
  generationId: number,
): { ordinal: number; eraCheck: EraCheck | null; ageDelta: number | null }[] =>
  (
    getDb()
      .prepare(
        'SELECT ordinal, era_check_json, age_delta FROM generation_results WHERE generation_id = ? ORDER BY ordinal',
      )
      .all(generationId) as { ordinal: number; era_check_json: string | null; age_delta: number | null }[]
  ).map((row) => ({
    ordinal: row.ordinal,
    eraCheck: row.era_check_json === null ? null : (JSON.parse(row.era_check_json) as EraCheck),
    ageDelta: row.age_delta,
  }));

const statusOf = (generationId: number): { status: string; error_code: string | null } =>
  getDb().prepare('SELECT status, error_code FROM generations WHERE id = ?').get(generationId) as {
    status: string;
    error_code: string | null;
  };

const resultReviews = (generationId: number): { verdict: string }[] =>
  getDb()
    .prepare(
      "SELECT verdict FROM content_reviews WHERE target_type = 'generation' AND target_id = ? AND stage = 'result'",
    )
    .all(generationId) as { verdict: string }[];

describe('ERA-01 复核判定只标注、不阻断（modules/M07 §5.3）', () => {
  it.each([['review'], ['reject']])('verdict=%s → 结果行照常写入、status=succeeded、图不软删', async (verdict) => {
    stubEra({
      verdict,
      findings: [{ item: '智能手机', reason: '人物右手持黑色全面屏手机，晚于所选年代' }],
      estimatedAgeRange: '66-74',
    });
    const anchorId = await makeAnchor('70-80岁');
    const id = await runOne(anchorId, 3);
    const rows = resultsOf(id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.ordinal)).toEqual([0, 1, 2]);
    expect(statusOf(id).status).toBe('succeeded');
    expect(rows.every((r) => r.eraCheck?.verdict === verdict)).toBe(true);
    expect(rows.every((r) => r.eraCheck?.passed === false)).toBe(true);
    // 落库只保留 EraCheck 四键，estimatedAgeRange 消费后丢弃。
    expect(rows.every((r) => Object.keys(r.eraCheck ?? {}).sort().join(',') === 'findings,model,passed,verdict')).toBe(
      true,
    );
    // 结果图都还在（未被软删）。
    const active = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM generation_results r JOIN photos p ON p.id = r.photo_id
         WHERE r.generation_id = ? AND p.deleted_at IS NULL`,
      )
      .get(id) as { n: number };
    expect(active.n).toBe(3);
  });
});

describe('ERA-02 年龄偏差落库（modules/M07 §5.4）', () => {
  it('结果侧与锚点区间中值相同（70-80 vs 70-80岁）→ age_delta = 0', async () => {
    stubEra({ verdict: 'pass', estimatedAgeRange: '70-80岁' });
    const anchorId = await makeAnchor('70-80岁');
    const id = await runOne(anchorId, 3);
    const rows = resultsOf(id);
    expect(rows.every((r) => r.eraCheck?.verdict === 'pass')).toBe(true);
    expect(rows.every((r) => r.ageDelta === 0)).toBe(true);
  });

  it('结果侧中值 83 − 锚点 90-100岁（中值 95）= −12（负 = 变年轻，不取绝对值）', async () => {
    stubEra({ verdict: 'reject', findings: [{ item: '玻璃幕墙现代楼宇', reason: '晚于所选年代' }], estimatedAgeRange: '80-86' });
    const anchorId = await makeAnchor('90-100岁');
    const id = await runOne(anchorId, 3);
    expect(resultsOf(id).every((r) => r.ageDelta === -12)).toBe(true);
  });

  it('锚点区间不可解析 → age_delta = NULL', async () => {
    stubEra({ verdict: 'pass', estimatedAgeRange: '66-74' });
    const anchorId = await makeAnchor('不详');
    const id = await runOne(anchorId, 2);
    expect(resultsOf(id).every((r) => r.ageDelta === null)).toBe(true);
  });
});

describe('复核失败留 NULL 且不阻断（modules/M07 §5.1 ③、§8）', () => {
  it('reviewEra 抛 PROVIDER_TIMEOUT → era_check_json / age_delta 留 NULL，status 仍 succeeded', async () => {
    const anchorId = await makeAnchor('70-80岁');
    const spy = vi
      .spyOn(getArk(), 'reviewEra')
      .mockRejectedValue(new ArkUpstreamError({ kind: 'timeout', message: 'review timeout' }));
    try {
      const id = await runOne(anchorId, 3);
      const rows = resultsOf(id);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.eraCheck === null && r.ageDelta === null)).toBe(true);
      expect(statusOf(id).status).toBe('succeeded');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('审核硬闸门（SEC-08 的 A 层旁证，modules/M07 §5.6）', () => {
  it('result=reject → 全部张被拒：failed/CONTENT_REJECTED、无结果行、有 content_reviews 与审计', async () => {
    stubSafety({ result: 'reject' });
    const anchorId = await makeAnchor('70-80岁');
    const id = await runOne(anchorId, 2);
    const { status, error_code: errorCode } = statusOf(id);
    const audits = getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'moderation.reject' AND target = ?")
      .get(`generation:${id}`) as { n: number };
    expect(status).toBe('failed');
    expect(errorCode).toBe('CONTENT_REJECTED');
    expect(resultsOf(id)).toHaveLength(0);
    expect(resultReviews(id)).toEqual([{ verdict: 'reject' }]);
    expect(audits.n).toBe(1);
  });

  it('result=review → 等同放行：status=succeeded、结果行照写、留 review 行', async () => {
    stubSafety({ result: 'review' });
    const anchorId = await makeAnchor('70-80岁');
    const id = await runOne(anchorId, 2);
    expect(statusOf(id).status).toBe('succeeded');
    expect(resultsOf(id)).toHaveLength(2);
    expect(resultReviews(id).every((r) => r.verdict === 'review')).toBe(true);
  });

  it('审核失败（provider 持续抛错）→ 不放过未审核的结果：零产出触发自动重试，再失败落 PROVIDER_TIMEOUT', async () => {
    vi.spyOn(getArk(), 'reviewSafety').mockImplementation(async (input) => {
      if (input.stage === 'result') throw new ArkUpstreamError({ kind: 'timeout', message: 'safety timeout' });
      return { raw: '{"verdict":"pass","reason":null}', model: 'mock-safety-model' };
    });
    const anchorId = await makeAnchor('70-80岁');
    const id = await runOne(anchorId, 2);
    // 零产出的瞬时错误按 `spec/04` §4.6 回 queued（attempt 0 → 1），不回滚、不写终态。
    expect(statusOf(id).status).toBe('queued');
    const stored = findGenerationById(id);
    if (stored === null) throw new Error('generation 丢失');
    await runGenerateJob(stored);
    const { status, error_code: errorCode } = statusOf(id);
    expect(status).toBe('failed');
    expect(errorCode).toBe('PROVIDER_TIMEOUT');
    expect(resultsOf(id)).toHaveLength(0);
  });
});
