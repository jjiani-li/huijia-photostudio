/**
 * 错误码 → 用户可见文案的**唯一代码侧镜像**（逐行对照 `docs/prd/spec/03-接口契约.md` §5 的
 * 「用户可见文案」列；改表先改文档）。服务端与前端共用这一份，不再各存一版：
 *
 * - 服务端：`src/server/domain/errors.ts` 的 `appError()` / `errorMessageOf()`（构造 `AppError` 与
 *   投影库里的 `error_code`）；`docs/prd/spec/04-技术基线与目录结构.md` §4.1 规定响应里的
 *   `error.message` 一律取本表，不回显库里的原文。
 * - 前端：`components/confirm/*` 与 `components/upload/*` 的兜底——**凡有服务端 `error.message`
 *   就一律以服务端为准**（`docs/prd/spec/03-接口契约.md` §1.3）；只有**没有响应 envelope 的网络级
 *   失败**（`fetch` 抛 `TypeError`）或服务端 `message` 为空的边界才取本表，避免把 `Failed to fetch`
 *   这类技术串呈现给用户（`docs/prd/pages/P01-上传与身份确认.md` §5、`pages/P00-设计基准与路由.md` §8）。
 */
import { ERROR_CODES, type ErrorCode } from './types';

/** 逐行对照 `docs/prd/spec/03-接口契约.md` §5 的「用户可见文案」列。 */
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

/** `ErrorCode` 的运行时判据（`components/error-notice.tsx` 与 `errorMessageOf` 共用）。 */
export const isErrorCode = (code: string): code is ErrorCode =>
  (ERROR_CODES as readonly string[]).includes(code);

/** 认不出的 `code` 兜底 `INTERNAL`（库里的 `error_code` 是 `TEXT`，类型上不保证是 `ErrorCode`）。 */
export const errorMessageOf = (code: string): string =>
  isErrorCode(code) ? ERROR_MESSAGE[code] : ERROR_MESSAGE.INTERNAL;
