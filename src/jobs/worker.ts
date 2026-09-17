import { nowIso } from '../server/domain/time';

/**
 * `pnpm worker` 的入口（`docs/prd/spec/04-技术基线与目录结构.md` §4.6）。
 * 本条（`tickets/T01`）只落空转循环：三表拉取、claim、心跳、启动回收、超时与自动重试
 * 归 `tickets/T09-生成编排：任务、worker、轮询、重试、额度.md`。
 */
const TICK_MS = 5_000;

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', scope: 'worker', msg, ...extra, at: nowIso() }));

const main = () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    log('worker idle', { ticks });
  }, TICK_MS);

  const stop = (signal: string) => {
    clearInterval(timer);
    log('worker stopped', { signal, ticks });
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  log('worker started', { tickMs: TICK_MS, note: '空转：任务拉取与心跳归 tickets/T09' });
};

main();
