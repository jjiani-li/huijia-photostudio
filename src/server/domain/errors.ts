import type { ErrorCode } from '../../shared/types';

/**
 * 错误码 → HTTP 状态码 / 用户可见文案的唯一映射表。
 * 逐行对照 `docs/prd/spec/03-接口契约.md` §5 错误码总表；改表先改文档。
 */
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

export const ERROR_MESSAGE: Record<ErrorCode, string> = {
  UNAUTHENTICATED: '请先登录',
  FORBIDDEN: '没有权限访问这张照片',
  NOT_FOUND: '这张照片找不到了',
  INVALID_PARAM: '选择有误，请重新选一下',
  INVALID_FILE_TYPE: '暂时只支持 jpg、png、webp、heic',
  FILE_TOO_LARGE: '这张照片太大了，换一张小一点的',
  CODE_INVALID: '验证码不对，再试一次',
  CODE_EXPIRED: '验证码过期了，重新获取一个',
  CODE_RATE_LIMITED: '刚刚已经发过了，稍等一下',
  CONSENT_REQUIRED: '需要先确认照片使用授权',
  ANCHOR_NOT_FOUND: '这次的人物特征记录找不到了',
  ANCHOR_NOT_CONFIRMED: '需要先确认"这就是他"，才能开始生成',
  ANCHOR_LOW_QUALITY: '这张照片的人物特征看不清，建议换一张更清楚的',
  REALNAME_REQUIRED: '需要先完成实名认证，才能开始生成',
  GENERATION_IN_PROGRESS: '上一组还在生成，稍等一下',
  QUOTA_EXCEEDED: '今天的生成额度用完了，明天再来吧',
  CONTENT_REJECTED: '这张照片暂时无法处理',
  PROVIDER_ERROR: '生成服务暂时不可用，请稍后重试',
  PROVIDER_TIMEOUT: '生成花的时间有点长，请重试一次',
  STORAGE_ERROR: '保存失败，请重试',
  INTERNAL: '出了点小问题，请重试',
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

/**
 * 库里的 `error_code`（`TEXT`，类型上不是 `ErrorCode`）→ 用户可见文案（`docs/prd/spec/04-技术基线与目录结构.md`
 * §4.1：响应里的 `error.message` 一律取文案表，**不回显库里的原文**）。认不出的码兜底 `INTERNAL`。
 */
export const errorMessageOf = (code: string): string =>
  ERROR_MESSAGE[code as ErrorCode] ?? ERROR_MESSAGE.INTERNAL;
