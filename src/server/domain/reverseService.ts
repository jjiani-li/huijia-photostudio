import { appError, ERROR_MESSAGE } from './errors';
import { nowIso } from './time';
import { findActivePhotoForUser } from '../db/repositories/photos';
import {
  findByIdForUser,
  insert,
  type PromptReverseJobRecord,
} from '../db/repositories/promptReverseJobs';
import { arkVisionModel } from '../ark';
import type { ErrorCode, PromptReverseJob } from '../../shared/types';

/**
 * F4 图片反推提示词的编排（`docs/prd/modules/M09-图片反推提示词.md` §4、§7）。
 * 只做两件事：入队校验 + 建 `queued` 行；读取并按 `docs/prd/spec/03-接口契约.md` §4 投影 DTO。
 * 读图与解析归 `src/jobs/handlers/reversePrompt.ts`（worker 内执行）。
 *
 * 边界：**不写入 `identity_anchors`**、不产出图片、不占生成额度（`modules/M09` §1）。
 */

export interface CreateReverseJobInput {
  userId: number;
  photoId: number;
}

/**
 * `POST /api/prompt-reverse-jobs`（`docs/prd/spec/03-接口契约.md` §3.8）：照片可为 `original` 或
 * `preprocessed`；不存在 / 属他人 / 已软删一律 `404 NOT_FOUND`（不返回 403，避免探测），
 * `kind='generated'` 一律 `400 INVALID_PARAM`（防链式自举）。每次调用建新 `queued` 行。
 */
export const createReverseJob = (input: CreateReverseJobInput): PromptReverseJob => {
  const photo = findActivePhotoForUser(input.photoId, input.userId);
  if (photo === null) throw appError('NOT_FOUND');
  if (photo.kind === 'generated') {
    throw appError('INVALID_PARAM', { fields: { photoId: ['结果图不能作为反推输入（防链式自举）'] } });
  }

  const record = insert({
    userId: input.userId,
    sourcePhotoId: photo.id,
    // `model` 取 `ARK_VISION_MODEL` 的当前值，不由 SQL 内联（`modules/M09` §3）。
    model: arkVisionModel(),
    status: 'queued',
    attempt: 0,
    createdAt: nowIso(),
  });
  return toPromptReverseJobDto(record);
};

/** 错误码 → 用户可见文案；`error_code` 是 `PromptReverseJob.error.code` 的来源（`modules/M09` §3）。 */
const errorMessageOf = (code: string): string => ERROR_MESSAGE[code as ErrorCode] ?? ERROR_MESSAGE.INTERNAL;

/**
 * `PromptReverseJobRecord` → `PromptReverseJob`（`docs/prd/spec/03-接口契约.md` §3.8、§4）：
 * 非终态时四个产物字段一律 `null`（不把 `running` 的半成品透出去）；`failed` 时 `error` 非空，
 * `message` 取文案表而非库里的原文（`spec/04-技术基线与目录结构.md` §4.1）。
 */
export const toPromptReverseJobDto = (record: PromptReverseJobRecord): PromptReverseJob => {
  const succeeded = record.status === 'succeeded';
  return {
    id: record.id,
    status: record.status,
    photoId: record.sourcePhotoId,
    model: record.model,
    resultJson: succeeded ? record.result : null,
    resultPrompt: succeeded ? record.resultPrompt : null,
    suggestEraCode: succeeded ? record.suggestEraCode : null,
    suggestSceneId: succeeded ? record.suggestSceneId : null,
    error: record.errorCode === null ? null : { code: record.errorCode, message: errorMessageOf(record.errorCode) },
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
  };
};

/** `GET /api/prompt-reverse-jobs/:id`（§3.8）：不是自己的任务一律 `404 NOT_FOUND`（`API-04`）。 */
export const readReverseJobForUser = (userId: number, id: number): PromptReverseJob => {
  const record = findByIdForUser(userId, id);
  if (record === null) throw appError('NOT_FOUND');
  return toPromptReverseJobDto(record);
};
