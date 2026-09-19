import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArkUpstreamError, getArk, resetArk } from '../ark';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { AppError } from '../domain/errors';
import { moderatePrompt, moderateResult, moderateUpload, parseSafetyVerdict } from './moderation';

/**
 * 三阶段内容审核的单元形态（`docs/prd/modules/M07-生成后复核与内容审核.md` §5.6、§8）：
 * 每个阶段 `pass` / `review` / `reject` 都写**恰好一行** `content_reviews`（`stage` / `target_type` 正确）、
 * 任一 `reject` 触发 `audit_logs(action='moderation.reject')`、`review` 不改变判定语义（等同放行、仅留痕）。
 *
 * 判定由 `ArkProvider.reviewSafety` 给出（fixture 回放在 `MockArkProvider` 内，见 `src/server/ark/mock.test.ts`），
 * 本文件用 spy 直接指定正文，避免并发改 `fixtures/ark/safety-review.json`。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-moderation-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  process.env.PROVIDER = 'mock';
  closeDb();
  resetArk();
  runMigrations();
  runSeed();
});

afterAll(() => {
  closeDb();
  resetArk();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.PROVIDER;
});

beforeEach(() => {
  getDb().prepare('DELETE FROM content_reviews').run();
  getDb().prepare("DELETE FROM audit_logs WHERE action = 'moderation.reject'").run();
  vi.restoreAllMocks();
});

/** 让 `reviewSafety` 回放固定判定；返回 spy 以便断言消费次数。 */
const stubSafety = (verdict: string, reason: string | null = null) =>
  vi.spyOn(getArk(), 'reviewSafety').mockResolvedValue({
    raw: JSON.stringify({ verdict, reason }),
    model: 'mock-safety-model',
  });

const reviewRows = (): { stage: string; target_type: string; target_id: number; verdict: string; model: string | null }[] =>
  getDb()
    .prepare('SELECT stage, target_type, target_id, verdict, model FROM content_reviews ORDER BY id')
    .all() as { stage: string; target_type: string; target_id: number; verdict: string; model: string | null }[];

const rejectAudits = (): { target: string | null; meta_json: string | null }[] =>
  getDb()
    .prepare("SELECT target, meta_json FROM audit_logs WHERE action = 'moderation.reject'")
    .all() as { target: string | null; meta_json: string | null }[];

const IMAGE = { mime: 'image/png', base64: 'AAAA' };

describe('三个阶段各写恰好一行 content_reviews（默认 pass）', () => {
  it('upload → photo:<id>、prompt → generation:0、result → generation:<id>，verdict=pass 且无审计', async () => {
    stubSafety('pass');
    expect(await moderateUpload({ userId: 1, photoId: 12, image: IMAGE })).toBe('pass');
    expect(await moderatePrompt({ userId: 1, prompt: '拼装后的 prompt 全文' })).toBe('pass');
    expect(await moderateResult({ userId: 1, generationId: 7, image: IMAGE })).toBe('pass');

    expect(reviewRows()).toEqual([
      { stage: 'upload', target_type: 'photo', target_id: 12, verdict: 'pass', model: 'mock-safety-model' },
      { stage: 'prompt', target_type: 'generation', target_id: 0, verdict: 'pass', model: 'mock-safety-model' },
      { stage: 'result', target_type: 'generation', target_id: 7, verdict: 'pass', model: 'mock-safety-model' },
    ]);
    expect(rejectAudits()).toHaveLength(0);
  });
});

describe('review 等同放行、仅留痕（modules/M07 §5.6）', () => {
  it('review-uncertain → verdict=review、照常写行、不写 moderation.reject 审计', async () => {
    stubSafety('review', '看不清的标语');
    expect(await moderateResult({ userId: 1, generationId: 3, image: IMAGE })).toBe('review');
    const rows = reviewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe('review');
    expect(rejectAudits()).toHaveLength(0);
  });
});

describe('reject 必须留痕（SEC-08 的写行口径，modules/M07 §5.6）', () => {
  it('result 阶段 reject-violation → verdict=reject + 一行 moderation.reject（meta 记 stage / targetId / reason）', async () => {
    stubSafety('reject', '样本判定为违规内容');
    expect(await moderateResult({ userId: 1, generationId: 7, image: IMAGE })).toBe('reject');
    expect(reviewRows()).toEqual([
      {
        stage: 'result',
        target_type: 'generation',
        target_id: 7,
        verdict: 'reject',
        model: 'mock-safety-model',
      },
    ]);
    const audits = rejectAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.target).toBe('generation:7');
    const meta = JSON.parse(audits[0]?.meta_json ?? '{}') as Record<string, unknown>;
    expect(meta.stage).toBe('result');
    expect(meta.targetId).toBe(7);
    expect(meta.reason).toBe('样本判定为违规内容');
  });

  it('upload 阶段 → photo:<id> 与审计 target 正确', async () => {
    stubSafety('reject');
    expect(await moderateUpload({ userId: 1, photoId: 12, image: IMAGE })).toBe('reject');
    expect(reviewRows()).toEqual([
      { stage: 'upload', target_type: 'photo', target_id: 12, verdict: 'reject', model: 'mock-safety-model' },
    ]);
    expect(rejectAudits()[0]?.target).toBe('photo:12');
  });

  it('prompt 阶段 → target_id 占位 0、reason 前置 prompt-stage 标记', async () => {
    stubSafety('reject', '违规文本');
    expect(await moderatePrompt({ userId: 1, prompt: 'prompt 全文' })).toBe('reject');
    const row = getDb()
      .prepare("SELECT target_type, target_id, reason FROM content_reviews WHERE stage = 'prompt'")
      .get() as { target_type: string; target_id: number; reason: string | null };
    expect(row.target_type).toBe('generation');
    expect(row.target_id).toBe(0);
    expect(row.reason).toBe('prompt-stage: 违规文本');
    expect(rejectAudits()[0]?.target).toBe('generation:0');
  });
});

describe('审核失败重试 1 次仍失败 → 抛错（不放过未审核的结果）', () => {
  it('provider 连续两次抛 PROVIDER_TIMEOUT → 调用 2 次、抛 AppError、不写 content_reviews', async () => {
    const spy = vi
      .spyOn(getArk(), 'reviewSafety')
      .mockRejectedValue(new ArkUpstreamError({ kind: 'timeout', message: 'timeout' }));
    await expect(moderateResult({ userId: 1, generationId: 5, image: IMAGE })).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(reviewRows()).toHaveLength(0);
  });

  it('第一次失败、第二次成功 → 判定照常落库（只重试 1 次）', async () => {
    const spy = vi
      .spyOn(getArk(), 'reviewSafety')
      .mockRejectedValueOnce(new ArkUpstreamError({ kind: 'timeout', message: 'timeout' }))
      .mockResolvedValueOnce({ raw: '{"verdict":"pass","reason":null}', model: 'mock-safety-model' });
    expect(await moderateResult({ userId: 1, generationId: 5, image: IMAGE })).toBe('pass');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(reviewRows()).toHaveLength(1);
  });
});

describe('parseSafetyVerdict：无法解析或非枚举 → PROVIDER_ERROR（不放过未审核的结果）', () => {
  const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
      return 'NO_THROW';
    } catch (err) {
      return err instanceof AppError ? err.code : `NON_APP_ERROR:${String(err)}`;
    }
  };

  it('合法 JSON（含 ```json 包裹）→ 判定与 reason', () => {
    expect(parseSafetyVerdict('```json\n{"verdict":"review","reason":"看不清的标语"}\n```')).toEqual({
      verdict: 'review',
      reason: '看不清的标语',
    });
    expect(parseSafetyVerdict('{"verdict":"pass","reason":null}')).toEqual({ verdict: 'pass', reason: null });
  });

  it('非 JSON / 非对象 / verdict 非枚举 → PROVIDER_ERROR', async () => {
    expect(await codeOf(async () => parseSafetyVerdict('不是 JSON'))).toBe('PROVIDER_ERROR');
    expect(await codeOf(async () => parseSafetyVerdict('[]'))).toBe('PROVIDER_ERROR');
    expect(await codeOf(async () => parseSafetyVerdict('{"verdict":"maybe"}'))).toBe('PROVIDER_ERROR');
  });

  it('reasonPrefix 前置到 reason（null 时只留前缀）', () => {
    expect(parseSafetyVerdict('{"verdict":"reject","reason":"违规"}', 'prompt-stage').reason).toBe(
      'prompt-stage: 违规',
    );
    expect(parseSafetyVerdict('{"verdict":"reject","reason":null}', 'prompt-stage').reason).toBe('prompt-stage');
  });
});
