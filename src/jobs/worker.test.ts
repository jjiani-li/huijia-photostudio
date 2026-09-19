import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../server/db/connection';
import { runMigrations } from '../server/db/migrate';
import { runSeed } from '../server/db/seed';
import {
  claimForRun,
  findById as findAnchorById,
  insert as insertAnchor,
  type InsertAnchorInput,
} from '../server/db/repositories/anchors';
import { insert as insertReverseJob } from '../server/db/repositories/promptReverseJobs';
import {
  findNextQueuedId as findNextGenerationId,
  insert as insertGeneration,
  type InsertGenerationInput,
} from '../server/db/repositories/generations';
import { nowIso } from '../server/domain/time';
import type { ErrorCode } from '../shared/types';
import type { JobHandler, JobHandlerMap, TaskSource } from './registry';
import { isAutoRetryable, processOne, reclaimStale, settleJobFailure } from './worker';

/**
 * worker 机制的单测（`docs/prd/spec/04-技术基线与目录结构.md` §4.6 是唯一事实源）：
 * claim 原子性（连续两次 claim 同一行，第二次 `changes === 0`）、三张表的启动回收（`ERR-02`）、
 * 自动重试判据与三张表同一套失败处置（`ERR-01` 的口径）、以及超时竞速。
 * 主循环本身不在测试里启动（`void main()` 被 `isMain(import.meta.url)` 挡住）。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-worker-'));
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

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

const makeAnchor = (over: Partial<InsertAnchorInput> = {}): number =>
  insertAnchor({
    userId: 1,
    inputPhotoIds: [1],
    preprocessedPhotoId: null,
    status: 'queued',
    attempt: 0,
    model: 'anchor-model',
    promptVersion: 'anchor-v1',
    quality: null,
    createdAt: nowIso(),
    ...over,
  }).id;

const makeGeneration = (over: Partial<InsertGenerationInput> = {}): number =>
  insertGeneration({
    userId: 1,
    anchorId: 1,
    eraCode: 'E2',
    sceneId: 1,
    profileId: null,
    referencePhotoIds: [],
    prompt: 'prompt',
    promptHash: 'a'.repeat(64),
    templateVersion: 'tpl-v1',
    eraPackVersion: 'era-v1',
    scenePackVersion: 'scene-v1',
    model: 'doubao-seedream-5-0-lite-260128',
    params: { size: '2048x2048', outputFormat: 'png', watermark: false, provider: 'mock' },
    requestedCount: 2,
    status: 'queued',
    attempt: 0,
    createdAt: nowIso(),
    ...over,
  }).id;

const rowOf = (table: string, id: number): Record<string, unknown> =>
  getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;

const startRunning = (table: string, id: number, startedAt: string): void => {
  getDb().prepare(`UPDATE ${table} SET status = 'running', started_at = ? WHERE id = ?`).run(startedAt, id);
};

describe('claim 原子性（§4.6）', () => {
  it('连续两次 claim 同一行：第一次 changes=1，第二次 changes=0', () => {
    const id = makeAnchor();
    expect(claimForRun(id, nowIso())).toBe(1);
    expect(claimForRun(id, nowIso())).toBe(0);
    expect(rowOf('identity_anchors', id).status).toBe('running');
  });

  it('claim 不自增 attempt（只有自动重试才自增）', () => {
    const id = makeAnchor({ attempt: 0 });
    claimForRun(id, nowIso());
    expect(rowOf('identity_anchors', id).attempt).toBe(0);
  });
});

describe('启动回收（§4.6，ERR-02）', () => {
  it('三张表的陈旧 running 行都回到 queued：started_at=NULL、attempt 不变', () => {
    const anchorId = makeAnchor({ status: 'running', attempt: 2 });
    startRunning('identity_anchors', anchorId, HOUR_AGO);

    const jobId = insertReverseJob({
      userId: 1,
      sourcePhotoId: 1,
      model: 'vision-model',
      status: 'running',
      attempt: 1,
      createdAt: nowIso(),
    }).id;
    startRunning('prompt_reverse_jobs', jobId, HOUR_AGO);

    const generationId = makeGeneration({ status: 'running', attempt: 1 });
    startRunning('generations', generationId, HOUR_AGO);

    // 阈值内的 running 行不得被回收。
    const freshId = makeGeneration({ status: 'running', attempt: 0 });
    startRunning('generations', freshId, nowIso());

    const reclaimed = reclaimStale(10);

    expect(reclaimed).toEqual({ anchors: 1, promptReverseJobs: 1, generations: 1 });
    for (const [table, id, attempt] of [
      ['identity_anchors', anchorId, 2],
      ['prompt_reverse_jobs', jobId, 1],
      ['generations', generationId, 1],
    ] as const) {
      const row = rowOf(table, id);
      expect(row.status).toBe('queued');
      expect(row.started_at).toBeNull();
      expect(row.attempt).toBe(attempt);
      expect(row.error_code).toBeNull();
    }
    expect(rowOf('generations', freshId).status).toBe('running');
  });

  it('没有陈旧行时返回全 0', () => {
    expect(reclaimStale(10)).toEqual({ anchors: 0, promptReverseJobs: 0, generations: 0 });
  });
});

describe('自动重试判据（§4.6）', () => {
  it('零产出 + 瞬时错误 + attempt<1 才可重试', () => {
    expect(isAutoRetryable({ code: 'PROVIDER_TIMEOUT', attempt: 0, produced: 0 })).toBe(true);
    expect(isAutoRetryable({ code: 'PROVIDER_ERROR', attempt: 0, produced: 0 })).toBe(true);
    expect(isAutoRetryable({ code: 'STORAGE_ERROR', attempt: 0, produced: 0 })).toBe(true);
    // 已有产出（partial）不重试
    expect(isAutoRetryable({ code: 'PROVIDER_ERROR', attempt: 0, produced: 1 })).toBe(false);
    // 不可重试的错误码
    expect(isAutoRetryable({ code: 'INTERNAL', attempt: 0, produced: 0 })).toBe(false);
    expect(isAutoRetryable({ code: 'CONTENT_REJECTED', attempt: 0, produced: 0 })).toBe(false);
    // attempt 已用掉
    expect(isAutoRetryable({ code: 'PROVIDER_TIMEOUT', attempt: 1, produced: 0 })).toBe(false);
  });
});

describe('失败处置（§4.6 自动重试，三张表同一写法）', () => {
  it('可重试：attempt 0 → 1 且回到 queued（写 error_code / error_message），再失败则落 failed', () => {
    const id = makeGeneration({ status: 'running', attempt: 0 });

    expect(
      settleJobFailure({
        table: 'generations',
        id,
        attempt: 0,
        produced: 0,
        code: 'PROVIDER_TIMEOUT',
        rawMessage: 'upstream timeout raw',
      }),
    ).toBe('requeued');

    const retried = rowOf('generations', id);
    expect(retried.status).toBe('queued');
    expect(retried.attempt).toBe(1);
    expect(retried.error_code).toBe('PROVIDER_TIMEOUT');
    expect(retried.error_message).toBe('upstream timeout raw');
    expect(retried.started_at).toBeNull();
    expect(retried.finished_at).toBeNull();

    expect(
      settleJobFailure({
        table: 'generations',
        id,
        attempt: 1,
        produced: 0,
        code: 'PROVIDER_TIMEOUT',
        rawMessage: 'upstream timeout raw',
      }),
    ).toBe('failed');

    const failed = rowOf('generations', id);
    expect(failed.status).toBe('failed');
    expect(failed.attempt).toBe(1);
    expect(failed.finished_at).not.toBeNull();
  });

  it('不可重试：直接落 failed，attempt 保持 0', () => {
    const id = makeGeneration({ status: 'running', attempt: 0 });
    expect(
      settleJobFailure({
        table: 'generations',
        id,
        attempt: 0,
        produced: 0,
        code: 'INTERNAL',
        rawMessage: 'InvalidParameter raw',
      }),
    ).toBe('failed');
    const row = rowOf('generations', id);
    expect(row.status).toBe('failed');
    expect(row.attempt).toBe(0);
    expect(row.error_code).toBe('INTERNAL');
  });
});

// ── 主循环的单格处理（stub handler 注入）──────────────────────────────────────────────

/** 模拟真实 handler 的固定结构：claim → 失败 → 按 §4.6 落库。 */
const failingHandler = (code: ErrorCode): JobHandler<'anchor.extract'> => async (job) => {
  if (claimForRun(job.anchorId, nowIso()) !== 1) return; // 没抢到直接放弃本轮
  const row = findAnchorById(job.anchorId);
  if (row === null) return;
  settleJobFailure({
    table: 'identity_anchors',
    id: row.id,
    attempt: row.attempt,
    produced: 0,
    code,
    rawMessage: `${code} raw`,
  });
};

const sourceFor = (jobType: TaskSource['jobType'], id: number | null): TaskSource => ({
  jobType,
  findNextQueuedId: () => id,
});

describe('processOne（主循环每格只取一行）', () => {
  it('该表没有 queued 行 → null（游标照常推进）', async () => {
    expect(await processOne(sourceFor('generate', null), { handlers: {} })).toBeNull();
  });

  it('该任务类型还没有 handler → null', async () => {
    const id = makeGeneration();
    expect(await processOne(sourceFor('generate', id), { handlers: {} })).toBeNull();
    expect(rowOf('generations', id).status).toBe('queued');
  });

  it('拉取只取一行且取最旧的那行（ORDER BY created_at LIMIT 1）', () => {
    getDb().prepare('DELETE FROM generations').run();
    const oldest = makeGeneration({ createdAt: '2026-01-01T00:00:00.000Z' });
    makeGeneration({ createdAt: '2026-02-01T00:00:00.000Z' });
    expect(findNextGenerationId()).toBe(oldest);
  });

  it('ERR-01 口径：retryable 失败先重试一次（attempt=1），再失败落 failed', async () => {
    const id = makeAnchor({ attempt: 0 });
    const source = sourceFor('anchor.extract', id);
    const handlers: JobHandlerMap = {
      'anchor.extract': failingHandler('PROVIDER_TIMEOUT'),
    };

    expect(await processOne(source, { handlers })).toMatchObject({ id, timedOut: false });
    expect(rowOf('identity_anchors', id).attempt).toBe(1);
    expect(rowOf('identity_anchors', id).status).toBe('queued');

    expect(await processOne(source, { handlers })).toMatchObject({ id, timedOut: false });
    const row = rowOf('identity_anchors', id);
    expect(row.status).toBe('failed');
    expect(row.attempt).toBe(1);
    expect(row.error_code).toBe('PROVIDER_TIMEOUT');
  });

  it('不可重试的错误码：第一次就落 failed 且 attempt=0（ERR-05 口径）', async () => {
    const id = makeAnchor({ attempt: 0 });
    const handlers: JobHandlerMap = { 'anchor.extract': failingHandler('INTERNAL') };
    await processOne(sourceFor('anchor.extract', id), { handlers });
    const row = rowOf('identity_anchors', id);
    expect(row.status).toBe('failed');
    expect(row.attempt).toBe(0);
    expect(row.error_code).toBe('INTERNAL');
  });

  it('claim-twice：handler 已在 running 时不重复产出（再次 processOne 不改变状态）', async () => {
    const id = makeAnchor({ status: 'running', attempt: 0 });
    const handlers: JobHandlerMap = { 'anchor.extract': failingHandler('INTERNAL') };
    await processOne(sourceFor('anchor.extract', id), { handlers });
    expect(rowOf('identity_anchors', id).status).toBe('running');
  });

  it('超时：JOB_TIMEOUT_SECONDS 到点即返回 timedOut，并调 source.onTimeout', async () => {
    const id = makeAnchor({ status: 'running', attempt: 0 });
    const timedOut: number[] = [];
    const source: TaskSource = {
      jobType: 'anchor.extract',
      findNextQueuedId: () => id,
      onTimeout: (jobId) => {
        timedOut.push(jobId);
        settleJobFailure({
          table: 'identity_anchors',
          id: jobId,
          attempt: 0,
          produced: 0,
          code: 'PROVIDER_TIMEOUT',
          rawMessage: 'job timeout',
        });
      },
    };
    const hang: JobHandler<'anchor.extract'> = () => new Promise<void>(() => {});

    const outcome = await processOne(source, { handlers: { 'anchor.extract': hang }, jobTimeoutMs: 20 });

    expect(outcome).toEqual({ jobType: 'anchor.extract', id, timedOut: true });
    expect(timedOut).toEqual([id]);
    expect(rowOf('identity_anchors', id).error_code).toBe('PROVIDER_TIMEOUT');
  });

  it('handler 抛错时主循环不炸（异常被吃掉，状态由 handler 自己负责）', async () => {
    const id = makeAnchor();
    const boom: JobHandler<'anchor.extract'> = () => Promise.reject(new Error('boom'));
    const outcome = await processOne(sourceFor('anchor.extract', id), {
      handlers: { 'anchor.extract': boom },
      jobTimeoutMs: 50,
    });
    expect(outcome).toMatchObject({ id, timedOut: false });
  });
});
