import fs from 'node:fs';
import path from 'node:path';
import { dbPath } from '../server/db/connection';
import { nowIso } from '../server/domain/time';

/**
 * worker 心跳文件（`docs/prd/spec/04-技术基线与目录结构.md` §4.6 是唯一事实源）：
 * `pnpm worker` 启动即每 5 秒把 `nowIso()` 写入 `<DATA_DIR>/worker-heartbeat`
 * （`<DATA_DIR>` = `dirname(DATABASE_PATH)`，默认 `./data`）；`GET /api/health` 读它的 mtime，
 * 超过 15 秒未更新即 `worker.alive = false`（`ERR-04`），前端据此提示"后台还没启动"。
 */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_STALE_MS = 15_000;

export interface HeartbeatView {
  alive: boolean;
  lastSeenAt: string | null;
}

/** 心跳文件路径：与库文件同目录（两个进程共享同一份数据目录）。 */
export const heartbeatPath = (): string => path.join(path.dirname(dbPath()), 'worker-heartbeat');

/** 判活只看 mtime；文件不存在 → `alive=false`、`lastSeenAt=null`。 */
export const readHeartbeat = (): HeartbeatView => {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(heartbeatPath());
  } catch {
    return { alive: false, lastSeenAt: null };
  }
  return {
    alive: Date.now() - stat.mtimeMs <= HEARTBEAT_STALE_MS,
    lastSeenAt: stat.mtime.toISOString(),
  };
};

/** 写心跳（内容取 `nowIso()`，判活看 mtime）；定时器的第一拍也走这里。 */
export const writeHeartbeat = (): void => {
  const file = heartbeatPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, nowIso());
};
