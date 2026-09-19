import { getDb } from '../connection';

/**
 * `usage_counters` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.12）。
 * 额度判断读 `users.daily_image_quota`；预扣与回滚归 `tickets/T09`。
 */
export interface UsageCounterRecord {
  userId: number;
  day: string;
  generations: number;
  images: number;
}

interface UsageRow {
  user_id: number;
  day: string;
  generations: number;
  images: number;
}

const toUsage = (row: UsageRow): UsageCounterRecord => ({
  userId: row.user_id,
  day: row.day,
  generations: row.generations,
  images: row.images,
});

export const getDay = (userId: number, day: string): UsageCounterRecord => {
  const row = getDb()
    .prepare('SELECT user_id, day, generations, images FROM usage_counters WHERE user_id = ? AND day = ?')
    .get(userId, day) as UsageRow | undefined;
  return row === undefined ? { userId, day, generations: 0, images: 0 } : toUsage(row);
};

/** 预扣：`generations += 1`、`images += count`（`modules/M06-生成编排.md` §5.2 第 ② 步）。 */
export const deduct = (userId: number, day: string, count: number): UsageCounterRecord => {
  getDb()
    .prepare(
      `INSERT INTO usage_counters (user_id, day, generations, images)
       VALUES (@userId, @day, 1, @count)
       ON CONFLICT(user_id, day) DO UPDATE SET
         generations = generations + 1, images = images + @count`,
    )
    .run({ userId, day, count });
  return getDay(userId, day);
};
