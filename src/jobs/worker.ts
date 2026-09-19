import type { ErrorCode } from '../shared/types';
import { isMain } from '../server/db/cli';
import * as anchorsRepo from '../server/db/repositories/anchors';
import * as generationsRepo from '../server/db/repositories/generations';
import * as reverseJobsRepo from '../server/db/repositories/promptReverseJobs';
import { isoMinutesAgo, nowIso } from '../server/domain/time';
import { HEARTBEAT_INTERVAL_MS, writeHeartbeat } from './heartbeat';
import {
  JOB_HANDLERS,
  TASK_SOURCES,
  type JobHandlerMap,
  type JobType,
  type TaskSource,
} from './registry';

/**
 * `pnpm worker` 的入口——`docs/prd/spec/04-技术基线与目录结构.md` §4.6 是本文件所有规则的唯一事实源：
 *
 * - **轮转拉取**：游标每次迭代推进一格（取不到行也推进），每格只取一行；
 * - **心跳**：`setInterval(5_000)` 写 `worker-heartbeat`，等待任务时也不停；
 * - **启动回收**：进程启动后对三张任务表各跑一次 `requeueStale`（`ERR-02`）；
 * - **超时**：handler 用 `JOB_TIMEOUT_SECONDS` 的竞速包裹，到点按 `PROVIDER_TIMEOUT` 处理；
 * - **自动重试**：`settleJobFailure` 是「零产出 + 瞬时错误 + `attempt < 1` → 回 `queued` 且 `attempt+1`，
 *   否则落 `failed`」的唯一实现，由各表 handler 在失败分支调用（`tickets/T10` / `tickets/T18`）。
 *
 * 本期 `WORKER_CONCURRENCY` 恒按 1 串行执行（不引入多 worker / 通用任务队列，§5）。
 */
const IDLE_MS = 1_000;

export const WORKER_DEFAULTS = {
  staleMinutes: 10,
  concurrency: 1,
  jobTimeoutSeconds: 120,
} as const;

/** 自动重试的瞬时错误集合（§4.6；`SQLITE_BUSY` 已映射为 `STORAGE_ERROR`）。 */
export const AUTO_RETRY_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_ERROR',
  'STORAGE_ERROR',
]);

/** `attempt` 达到该值后不再自动重试（只重试一次，§4.6）。 */
export const AUTO_RETRY_MAX_ATTEMPT = 1;

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ level, scope: 'worker', msg, ...extra, at: nowIso() });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

const describe = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 环境变量 → 正整数；缺省或非法值取默认（不新增变量，清单见 `spec/08-本地开发指南.md` §4）。 */
export const envInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/** 三张任务表各回收一次陈旧 `running` 行（§4.6、`ERR-02`）；返回各表命中行数。 */
export const reclaimStale = (
  staleMinutes: number,
): { anchors: number; promptReverseJobs: number; generations: number } => {
  const beforeIso = isoMinutesAgo(staleMinutes);
  return {
    anchors: anchorsRepo.requeueStale(beforeIso),
    promptReverseJobs: reverseJobsRepo.requeueStale(beforeIso),
    generations: generationsRepo.requeueStale(beforeIso),
  };
};

// ── 自动重试（§4.6）：三张表同一套判据与同一套状态写入 ──────────────────────────────────

export type JobTable = 'identity_anchors' | 'prompt_reverse_jobs' | 'generations';

export interface JobFailureInput {
  table: JobTable;
  id: number;
  attempt: number;
  /** 本次成功转存并落库的结果数；`> 0` 时不得自动重试。 */
  produced: number;
  code: ErrorCode;
  /** 上游原文：只落库供排查，响应里的 `error.message` 一律取文案表（`spec/04` §4.1）。 */
  rawMessage: string;
}

/** 判据：零产出 + 错误码在瞬时集合内 + `attempt < 1`。 */
export const isAutoRetryable = (input: { code: ErrorCode; attempt: number; produced: number }): boolean =>
  input.produced === 0 && input.attempt < AUTO_RETRY_MAX_ATTEMPT && AUTO_RETRY_ERROR_CODES.has(input.code);

/** 三张表各自的失败写入（SQL 全部落在 repository 层）。 */
interface SettleOps {
  requeueForRetry(input: { id: number; attempt: number; code: ErrorCode; raw: string }): void;
  markFailed(input: { id: number; attempt: number; code: ErrorCode; raw: string; at: string }): void;
}

const SETTLE_OPS: Record<JobTable, SettleOps> = {
  identity_anchors: {
    requeueForRetry: ({ id, attempt, code, raw }) => anchorsRepo.requeueForRetry(id, attempt, code, raw),
    markFailed: ({ id, code, raw, at }) =>
      anchorsRepo.markFailed({ id, errorCode: code, errorMessage: raw, quality: null, finishedAt: at }),
  },
  prompt_reverse_jobs: {
    requeueForRetry: ({ id, attempt, code, raw }) => reverseJobsRepo.requeueForRetry(id, attempt, code, raw),
    markFailed: ({ id, code, raw, at }) => reverseJobsRepo.markTerminalFailure(id, code, raw, at),
  },
  generations: {
    requeueForRetry: ({ id, attempt, code, raw }) =>
      generationsRepo.updateStatus({
        id,
        status: 'queued',
        attempt,
        errorCode: code,
        errorMessage: raw,
        startedAt: null,
        finishedAt: null,
      }),
    markFailed: ({ id, attempt, code, raw, at }) =>
      generationsRepo.updateStatus({
        id,
        status: 'failed',
        attempt,
        errorCode: code,
        errorMessage: raw,
        startedAt: null,
        finishedAt: at,
      }),
  },
};

/**
 * 失败处置的唯一入口：可重试 → 置回 `queued` 且 `attempt + 1`（`attempt` 只在重试时自增，
 * claim 阶段不动）；否则落终态 `failed`（`attempt` 保持不变）。供各表 handler 的失败分支调用
 * （`tickets/T10` / `tickets/T18`）。
 */
export const settleJobFailure = (input: JobFailureInput): 'requeued' | 'failed' => {
  const ops = SETTLE_OPS[input.table];
  if (isAutoRetryable(input)) {
    ops.requeueForRetry({ id: input.id, attempt: input.attempt + 1, code: input.code, raw: input.rawMessage });
    return 'requeued';
  }
  ops.markFailed({ id: input.id, attempt: input.attempt, code: input.code, raw: input.rawMessage, at: nowIso() });
  return 'failed';
};

// ── 单格处理：取一行 → 跑 handler（带超时竞速）────────────────────────────────────────

/**
 * 三张表的 payload 键名各不相同（`anchorId` / `generationId` / `jobId`）：按任务类型收窄后再调用，
 * 避免把联合类型塞给单个 handler，也让「没有 handler」这件事只在这里判一次。
 */
const bindHandler = (
  jobType: JobType,
  id: number,
  signal: AbortSignal,
  handlers: JobHandlerMap,
): (() => Promise<void>) | undefined => {
  switch (jobType) {
    case 'anchor.extract': {
      const handler = handlers['anchor.extract'];
      return handler === undefined ? undefined : () => handler({ anchorId: id, signal });
    }
    case 'generate': {
      const handler = handlers['generate'];
      return handler === undefined ? undefined : () => handler({ generationId: id, signal });
    }
    case 'reverse.prompt': {
      const handler = handlers['reverse.prompt'];
      return handler === undefined ? undefined : () => handler({ jobId: id, signal });
    }
    default:
      return undefined;
  }
};

export interface ProcessOptions {
  /** 测试注入口；缺省用 `JOB_HANDLERS`。 */
  handlers?: JobHandlerMap;
  jobTimeoutMs?: number;
}

export interface ProcessOutcome {
  jobType: JobType;
  id: number;
  timedOut: boolean;
}

/**
 * 处理一张表的当前一行：没有 `queued` 行、或该任务类型还没有 handler → `null`（主循环继续轮转）。
 * handler 的异常在这里被吃掉（handler 契约要求自己落终态，`spec/04` §4.1）；
 * 超时按 `source.onTimeout` 兜底并把 `timedOut` 报给主循环。
 */
export const processOne = async (
  source: TaskSource,
  options: ProcessOptions = {},
): Promise<ProcessOutcome | null> => {
  const id = source.findNextQueuedId();
  if (id === null) return null;

  // `spec/04-技术基线与目录结构.md` §4.6：handler 用 `AbortController` 包裹，超时即中止。
  const controller = new AbortController();
  const handler = bindHandler(source.jobType, id, controller.signal, options.handlers ?? JOB_HANDLERS);
  if (handler === undefined) return null;

  const jobTimeoutMs = options.jobTimeoutMs ?? WORKER_DEFAULTS.jobTimeoutSeconds * 1_000;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), jobTimeoutMs);
  });
  const run = (async (): Promise<'done'> => {
    try {
      await handler();
    } catch (err) {
      log('error', 'handler threw', { jobType: source.jobType, id, error: describe(err) });
    }
    return 'done';
  })();

  try {
    const winner = await Promise.race([run, timeout]);
    if (winner === 'done') return { jobType: source.jobType, id, timedOut: false };
    log('warn', 'job timeout', { jobType: source.jobType, id, jobTimeoutMs });
    // 通知支持 `signal` 的 handler（fetch 等）立刻停止；再按 `onTimeout` 兜底落库。
    controller.abort();
    try {
      source.onTimeout?.(id);
    } catch (err) {
      log('error', 'onTimeout failed', { jobType: source.jobType, id, error: describe(err) });
    }
    return { jobType: source.jobType, id, timedOut: true };
  } finally {
    clearTimeout(timer);
  }
};

// ── 主循环 ────────────────────────────────────────────────────────────────────────

let running = true;

/** 停止信号（SIGINT / SIGTERM）→ 当前 handler 跑完即退出。 */
export const requestStop = (): void => {
  running = false;
};

export const main = async (): Promise<void> => {
  const staleMinutes = envInt('WORKER_STALE_MINUTES', WORKER_DEFAULTS.staleMinutes);
  const concurrency = envInt('WORKER_CONCURRENCY', WORKER_DEFAULTS.concurrency);
  const jobTimeoutSeconds = envInt('JOB_TIMEOUT_SECONDS', WORKER_DEFAULTS.jobTimeoutSeconds);

  const reclaimed = reclaimStale(staleMinutes);
  log('info', 'worker started', {
    idleMs: IDLE_MS,
    staleMinutes,
    concurrency,
    jobTimeoutSeconds,
    tables: TASK_SOURCES.map((source) => source.jobType),
    reclaimed,
  });

  writeHeartbeat();
  const heartbeat = setInterval(() => {
    try {
      writeHeartbeat();
    } catch (err) {
      log('warn', 'heartbeat write failed', { error: describe(err) });
    }
  }, HEARTBEAT_INTERVAL_MS);

  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);

  let cursor = 0;
  let misses = 0;
  while (running) {
    try {
      const source = TASK_SOURCES[cursor];
      cursor = (cursor + 1) % TASK_SOURCES.length;
      if (source === undefined) continue;
      const outcome = await processOne(source, { jobTimeoutMs: jobTimeoutSeconds * 1_000 });
      if (outcome !== null) {
        misses = 0;
        continue;
      }
      // 一整圈都没取到活：等 ≤ 1 秒再进下一轮（§4.6）。
      misses += 1;
      if (misses >= TASK_SOURCES.length) {
        misses = 0;
        await sleep(IDLE_MS);
      }
    } catch (err) {
      // handler 自身绝不抛错；这里兜的是取任务 / 落库等意外，主循环必须继续。
      log('error', 'tick failed', { error: describe(err) });
      await sleep(IDLE_MS);
    }
  }

  clearInterval(heartbeat);
  log('info', 'worker stopped', {});
  process.exit(0);
};

if (isMain(import.meta.url)) {
  void main();
}
