import { appError } from '../domain/errors';

/**
 * 列表端点的不透明游标（`docs/prd/spec/03-接口契约.md` §3.2、§3.6）。
 * 前端只回传、不解析（§6.4）；解码失败或把一边的游标传给另一边 → `400 INVALID_PARAM`。
 * `/api/photos` 的游标带前缀 `ph|`，与 `/api/history` 的不透明串**互不通用**。
 */
export interface CursorValue {
  createdAt: string;
  id: number;
}

const CURSOR_RE = /^\d{4}-\d{2}-\d{2}T.*\|\d+$/;

export const PHOTO_CURSOR_PREFIX = 'ph|';

export const encodeCursor = (value: CursorValue, prefix = ''): string =>
  Buffer.from(`${prefix}${value.createdAt}|${value.id}`, 'utf8').toString('base64url');

export const decodeCursor = (raw: string, prefix = ''): CursorValue => {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  if (prefix !== '' && !text.startsWith(prefix)) throw appError('INVALID_PARAM');
  const body = text.slice(prefix.length);
  if (!CURSOR_RE.test(body)) throw appError('INVALID_PARAM');
  const idx = body.lastIndexOf('|');
  return { createdAt: body.slice(0, idx), id: Number(body.slice(idx + 1)) };
};
