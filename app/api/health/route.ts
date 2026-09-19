import { ok, withErrorHandling } from '../../../src/server/http/respond';
import { readEraSceneConfig } from '../../../src/server/db/repositories/config';
import { readHeartbeat } from '../../../src/jobs/heartbeat';

/**
 * `GET /api/health`（免登录）— 形状见 `docs/prd/spec/03-接口契约.md` §3.7：
 * `{ ok, db: { ok, eras, scenes, profiles }, provider: { mode, arkConfigured }, worker: { alive, lastSeenAt } }`。
 *
 * `db` 三张配置表的计数不符预期（未跑 `pnpm seed`）即 `ok=false`；
 * `worker` 读 `./data/worker-heartbeat` 的 mtime，超过 15 秒未更新即 `alive=false`（`ERR-04`，
 * 阈值与写法见 `spec/04-技术基线与目录结构.md` §4.6）；`provider` 只反映环境变量。
 */
const EXPECTED = { eras: 4, scenes: 5, profiles: 20 } as const;

export const GET = withErrorHandling(async () => {
  const config = readEraSceneConfig();
  const dbOk =
    config.eras.length === EXPECTED.eras &&
    config.scenes.length === EXPECTED.scenes &&
    config.profiles.length === EXPECTED.profiles;
  return ok({
    ok: dbOk,
    db: {
      ok: dbOk,
      eras: config.eras.length,
      scenes: config.scenes.length,
      profiles: config.profiles.length,
    },
    provider: {
      mode: process.env.PROVIDER ?? 'mock',
      arkConfigured: Boolean(process.env.ARK_API_KEY),
    },
    worker: readHeartbeat(),
  });
});
