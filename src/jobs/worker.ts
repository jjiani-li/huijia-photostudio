import { isMain } from '../server/db/cli';
import * as anchorsRepo from '../server/db/repositories/anchors';
import * as generationsRepo from '../server/db/repositories/generations';
import * as reverseJobsRepo from '../server/db/repositories/promptReverseJobs';
import { isoMinutesAgo, nowIso } from '../server/domain/time';
import { HEARTBEAT_INTERVAL_MS, writeHeartbeat } from './heartbeat';
import { PURGE_INTERVAL_MS, runPurge } from './handlers/purge';
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
 * - **自动重试**：判据与写入在 `src/jobs/settle.ts`（避免与 `registry` 形成循环导入）。
 *
 * 本期 `WORKER_CONCURRENCY` 恒按 1 串行执行（不引入多 worker / 通用任务队列，§5）。
 */
const IDLE_MS = 1_000;

export const WORKER_DEFAULTS = {
  staleMinutes: 10,
  concurrency: 1,
  jobTimeoutSeconds: 120,
} as const;

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

/**
 * 清一轮软删照片（`docs/prd/modules/M08-账号历史与彻底删除.md` §5.3）：异常必须被吞掉，
 * 记日志后返回——**绝不中断 worker**。
 */
export const safePurge = async (): Promise<void> => {
  try {
    const result = await runPurge();
    log('info', 'purge done', { ...result });
  } catch (err) {
    log('error', 'purge failed', { error: describe(err) });
  }
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

  // 进程启动第一轮立即清一次；其后每轮空转时按间隔触发（§5.3）。
  await safePurge();
  let lastPurgeAt = Date.now();

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
    // 到点且当前串行主循环必然空闲 → 顺带清一轮（`modules/M08` §5.3）。
    if (Date.now() - lastPurgeAt >= PURGE_INTERVAL_MS) {
      await safePurge();
      lastPurgeAt = Date.now();
    }
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
