/**
 * 前后端唯一共享的类型层（`app/` 与 `src/server/` 都可 import；本文件不允许 import 任何 `src/server/` 下的东西）。
 * 形状以 `docs/prd/spec/03-接口契约.md` §4–§5 为准；错误码清单见 §5 错误码总表。
 */

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_PARAM',
  'INVALID_FILE_TYPE',
  'FILE_TOO_LARGE',
  'CODE_INVALID',
  'CODE_EXPIRED',
  'CODE_RATE_LIMITED',
  'CONSENT_REQUIRED',
  'ANCHOR_NOT_FOUND',
  'ANCHOR_NOT_CONFIRMED',
  'ANCHOR_LOW_QUALITY',
  'REALNAME_REQUIRED',
  'GENERATION_IN_PROGRESS',
  'QUOTA_EXCEEDED',
  'CONTENT_REJECTED',
  'PROVIDER_ERROR',
  'PROVIDER_TIMEOUT',
  'STORAGE_ERROR',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** ISO-8601 UTC 字符串，如 `2026-09-17T15:07:42.000Z` */
export type Iso = string;

/** 错误响应的统一 envelope（`docs/prd/spec/03-接口契约.md` §1.3）；成功响应不用 envelope。 */
export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}
