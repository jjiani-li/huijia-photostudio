import { nowIso } from '../server/domain/time';
import { findNextQueuedId, resetStaleRunning } from '../server/db/repositories/anchors';
import { JOB_HANDLERS } from './registry';

/**
 * `pnpm worker` 的入口（`docs/prd/spec/04-技术基线与目录结构.md` §4.6）。
 *
 * 本条（`tickets/T06`）只落 `identity_anchors` 所需的最小拉取循环：启动时回收一次 stale `running`，
 * 之后循环「取一行 `queued` → 跑 handler」。三表轮转、心跳、超时与自动重试、
 * `prompt_reverse_jobs` / `generations` 的 handler 全部归 `tickets/T09`（本文件届时被替换）。
 */
const IDLE_MS = 1_000;

const staleMinutes = (): number => Number(process.env.WORKER_STALE_MINUTES ?? 10);

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ level, scope: 'worker', msg, ...extra, at: nowIso() });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let running = true;

/** 启动时回收（§4.6）：`running` 超时回 `queued`，`attempt` 不变。 */
const reclaimStale = (): void => {
  const minutes = staleMinutes();
  const staleBefore = new Date(Date.now() - minutes * 60_000).toISOString();
  const reclaimed = resetStaleRunning(staleBefore);
  log('info', 'stale running reclaimed', { reclaimed, staleBefore, staleMinutes: minutes });
};

const tick = async (): Promise<void> => {
  const anchorId = findNextQueuedId();
  if (anchorId === null) {
    await sleep(IDLE_MS);
    return;
  }
  await JOB_HANDLERS['anchor.extract']({ anchorId });
};

const main = async (): Promise<void> => {
  reclaimStale();
  log('info', 'worker started', { idleMs: IDLE_MS, tables: ['identity_anchors'] });

  while (running) {
    try {
      await tick();
    } catch (err) {
      // handler 自身绝不抛错；这里兜的是取任务 / 落库等意外，主循环必须继续。
      log('error', 'tick failed', { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      await sleep(IDLE_MS);
    }
  }

  log('info', 'worker stopped', {});
  process.exit(0);
};

process.on('SIGINT', () => {
  running = false;
});
process.on('SIGTERM', () => {
  running = false;
});

void main();
