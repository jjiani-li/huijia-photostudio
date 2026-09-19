import { encodeCursor, type CursorValue } from './cursor';
import { appError } from '../domain/errors';

/**
 * 列表端点的分页公共段（`docs/prd/spec/03-接口契约.md` §3.2、§3.6）：
 * `limit ∈ [1,50]`（缺省 20）与「多取一行探测下一页」的游标包装。`/api/history` 与 `/api/photos` 各带自己的
 * 游标前缀，故只共享这一段、不共享编解码语义。
 */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 50;

export const parseLimit = (raw: string | null): number => {
  if (raw === null) return DEFAULT_PAGE_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw appError('INVALID_PARAM', { fields: { limit: ['必须是 [1,50] 的整数'] } });
  }
  return value;
};

/** `rows` 由调用方按 `LIMIT limit + 1` 取出；返回本页与 `nextCursor`。 */
export const pageOf = <T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => CursorValue,
  prefix = '',
): { rows: T[]; nextCursor: string | null } => {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeCursor(cursorOf(last), prefix) : null;
  return { rows: page, nextCursor };
};
