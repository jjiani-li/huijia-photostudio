/**
 * 错误码 → 兜底文案的前端镜像（`docs/prd/pages/P01-上传与身份确认.md` §7）。
 *
 * **唯一事实源仍是 `docs/prd/spec/03-接口契约.md` §5**：前端一律优先展示服务端 `error.message`
 * （`spec/03-接口契约.md` §1.3），本表只用于**没有响应 envelope 的失败**（上传 / 预处理 / 确认
 * 过程中抛出的网络级异常，或服务端 `error.message` 为空的边界），避免把 `TypeError: Failed to fetch`
 * 这类技术串直接呈现给用户。
 *
 * 与 `src/server/domain/errors.ts` 的 `ERROR_MESSAGE` 是**同一张表的两侧镜像**：两者都逐行对照
 * `spec/03-接口契约.md` §5，改表先改文档、再同步这两处（`spec/09-施工纪律.md` §4 D13）。
 * `Record<ErrorCode, string>` 让穷尽性由类型检查兜住（少一个键即编译失败）。
 */
import { ERROR_CODES, type ErrorCode } from './types';

/** 逐行对照 `docs/prd/spec/03-接口契约.md` §5 的「用户可见文案」列。 */
export const API_ERROR_MESSAGE: Record<ErrorCode, string> = {
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

export const isErrorCode = (code: string): code is ErrorCode =>
  (ERROR_CODES as readonly string[]).includes(code);

/** 认不出的 `code` 兜底 `INTERNAL`（与 `components/error-notice.tsx` 的 `knownCode` 同一口径）。 */
export const apiErrorMessage = (code: string): string =>
  isErrorCode(code) ? API_ERROR_MESSAGE[code] : API_ERROR_MESSAGE.INTERNAL;
