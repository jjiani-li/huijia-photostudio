import { getDay, rollback } from '../db/repositories/usage';
import { findById } from '../db/repositories/users';
import { appError } from '../domain/errors';
import { dayKey } from '../domain/time';

/**
 * 额度的领域封装（`docs/prd/modules/M08-账号历史与彻底删除.md` §3.1：
 * `readQuota()` / `QuotaView` 随额度下沉归 `tickets/T09`；阈值与回滚规则见
 * `docs/prd/modules/M06-生成编排.md` §5.1 第 7 步、§5.6）。
 *
 * 额度日 = `generations.created_at` 的 UTC 日期（`dayKey()`），不是 worker 完成日；
 * 计数只在 `usage_counters` 里，不落任何金额。`GET /api/me` 的 `quota` 段由 `tickets/T12` 消费。
 */
export interface QuotaView {
  day: string;
  images: number;
  limit: number;
  remaining: number;
}

/** 当日额度快照：`remaining` 下限为 0（超额时不为负）。 */
export const readQuota = (userId: number): QuotaView => {
  const day = dayKey();
  const limit = findById(userId)?.dailyImageQuota ?? 0;
  const images = getDay(userId, day).images;
  return { day, images, limit, remaining: Math.max(0, limit - images) };
};

/**
 * §5.1 第 7 步：`images + count > limit` → `429 QUOTA_EXCEEDED`，**在任何写操作之前**完成
 * （`SEC-04` 要求失败时不产生 `generations` 行）；入队事务内再用同一函数做复查。
 */
export const assertQuotaAvailable = (userId: number, count: number): void => {
  const { images, limit } = readQuota(userId);
  if (images + count > limit) throw appError('QUOTA_EXCEEDED');
};

/**
 * §5.6 回滚：产出 `n` 张时把未产出的 `requestedCount - n` 张退回入队日那一行。
 * `generations` 计数不回滚；`unproduced <= 0` 时 repository 侧不执行语句。
 */
export const rollbackUnproduced = (userId: number, day: string, unproduced: number): void => {
  rollback(userId, day, unproduced);
};
