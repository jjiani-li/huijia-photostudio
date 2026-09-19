/**
 * 时间的唯一入口（`docs/prd/spec/04-技术基线与目录结构.md` §4.2）：
 * 业务代码不得用别的方式生成时间字符串，也不得用本地时区格式。
 */

/** UTC ISO-8601，毫秒精度，`Z` 结尾：`2026-09-17T15:07:42.000Z` */
export const nowIso = (): string => new Date().toISOString();

/** `nowIso()` 的派生入口：N 分钟前的 UTC ISO（worker 启动回收的阈值，`spec/04` §4.6）。 */
export const isoMinutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** `nowIso()` 的派生入口：N 分钟后的 UTC ISO（验证码有效期、会话 `expires_at`）。 */
export const isoMinutesFromNow = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000).toISOString();

/** 额度日的「今天」，UTC：`YYYY-MM-DD` */
export const dayKey = (): string => nowIso().slice(0, 10);
