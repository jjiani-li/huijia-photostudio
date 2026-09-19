import type { ErrorCode } from '../../shared/types';
import { ERROR_MESSAGE } from '../../shared/error-message';

/**
 * 错误码 → HTTP 状态码的唯一映射表（逐行对照 `docs/prd/spec/03-接口契约.md` §5 错误码总表）。
 * **用户可见文案不在这里**：唯一代码侧镜像是 `src/shared/error-message.ts` 的 `ERROR_MESSAGE`
 * （前后端共用一份，避免同一张表出现两个版本），这里只把它转给调用方。
 */
export { ERROR_MESSAGE, errorMessageOf } from '../../shared/error-message';

export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_PARAM: 400,
  INVALID_FILE_TYPE: 400,
  FILE_TOO_LARGE: 413,
  CODE_INVALID: 400,
  CODE_EXPIRED: 400,
  CODE_RATE_LIMITED: 429,
  CONSENT_REQUIRED: 403,
  ANCHOR_NOT_FOUND: 404,
  ANCHOR_NOT_CONFIRMED: 409,
  ANCHOR_LOW_QUALITY: 422,
  REALNAME_REQUIRED: 409,
  GENERATION_IN_PROGRESS: 409,
  QUOTA_EXCEEDED: 429,
  CONTENT_REJECTED: 422,
  PROVIDER_ERROR: 502,
  PROVIDER_TIMEOUT: 504,
  STORAGE_ERROR: 500,
  INTERNAL: 500,
};

/**
 * 全项目唯一的错误类型（`docs/prd/spec/04-技术基线与目录结构.md` §4.1）。
 * Route handler 一律 `throw` 它，由 `withErrorHandling()` 转成响应，不得自己拼错误 JSON。
 */
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 按 `code` 取状态码与文案的构造入口；`details` 仅用于开发调试。 */
export const appError = (code: ErrorCode, details?: unknown): AppError =>
  new AppError(code, ERROR_MESSAGE[code], ERROR_STATUS[code], details);
