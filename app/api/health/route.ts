import { ok, withErrorHandling } from '../../../src/server/http/respond';

/**
 * `GET /api/health`（免登录）— 形状见 `docs/prd/spec/03-接口契约.md` §3.7：
 * `{ ok, db: { ok, eras, scenes, profiles }, provider: { mode, arkConfigured }, worker: { alive, lastSeenAt } }`。
 *
 * 本条（`tickets/T01`）只保证骨架存活：`db` 三张配置表由 `tickets/T02` 落库后才有计数，
 * `worker.alive` 的心跳由 `tickets/T09` 写。因此此刻 `ok` 的语义是「服务可用」，
 * db.ok / worker.alive 如实报 false；T02 / T09 到位后 `ok` 收紧为三者的合成判据。
 */
export const GET = withErrorHandling(async () =>
  ok({
    ok: true,
    db: { ok: false, eras: 0, scenes: 0, profiles: 0 },
    provider: {
      mode: process.env.PROVIDER ?? 'mock',
      arkConfigured: Boolean(process.env.ARK_API_KEY),
    },
    worker: { alive: false, lastSeenAt: null },
  }),
);
