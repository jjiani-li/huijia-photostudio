import { createHash } from 'node:crypto';
import { AppError, appError } from './errors';
import { nowIso } from './time';
import { getDb } from '../db/connection';
import { buildKey, getStorage } from '../storage';
import {
  findActivePhotoForUser,
  findPreprocessedBySource,
  insertPreprocessed,
  type PhotoRecord,
} from '../db/repositories/photos';
import { findByIdForUser, insert, type AnchorRecord } from '../db/repositories/anchors';
import { writeAudit } from '../security/audit';
import { buildAnalysisInput, normalize } from '../images/preprocess';
import { scoreQuality } from '../images/quality';
import { arkVisionModel } from '../ark';
import { ANCHOR_PROMPT_VERSION } from '../prompt/versions';
import { toPhotoDto } from './photoService';
import type { Anchor, Photo, Quality } from '../../shared/types';

/**
 * F1：预处理（`docs/prd/modules/M02-预处理与质量评分.md` §5.3）与锚点编排
 * （`docs/prd/modules/M03-身份锚点提取.md` §3、§4）。
 * 唯一允许同时调 repository + `images/` + `storage/` 的地方。
 * 同一 `:id` 的并发请求用进程内单飞表去重（dev server 单进程，本期不引入分布式锁）。
 */
export interface PreprocessResult {
  photo: PhotoRecord;
  quality: Quality;
}

const inFlight = new Map<string, Promise<PreprocessResult>>();

export const preprocessPhoto = (userId: number, photoId: number): Promise<PreprocessResult> => {
  // 键必须带 userId：只按 photoId 去重会让并发的他人请求拿到属主的 in-flight 结果（跨用户读取）。
  const flightKey = `${userId}:${photoId}`;
  const running = inFlight.get(flightKey);
  if (running !== undefined) return running;
  const task = doPreprocess(userId, photoId).finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, task);
  return task;
};

const doPreprocess = async (userId: number, photoId: number): Promise<PreprocessResult> => {
  // ① 读行：不存在 / 属他人 / 已软删 → 404；kind 校验 → 400（不返回 403，API-04）。
  const source = findActivePhotoForUser(photoId, userId);
  if (source === null) throw appError('NOT_FOUND');
  if (source.kind !== 'original') {
    throw appError('INVALID_PARAM', { fields: { id: ['只接受 kind=original 的照片'] } });
  }

  // ② 幂等：命中已有 preprocessed 行 → 直接返回，不重算、不落新行、不写审计（判重先于读文件）。
  const existing = findPreprocessedBySource(photoId);
  if (existing !== null) {
    if (existing.qualityJson === null) throw appError('INTERNAL', { reason: 'preprocessed 行缺少 quality_json' });
    return { photo: existing, quality: existing.qualityJson };
  }

  // ③ 读文件 → ④ 七步归一化 → ⑤ 评分 → ⑥ 落盘 → ⑦ 单事务写 photos + audit_logs。
  const original = await getStorage().read(source.storageKey);
  const normalized = await normalize(original);
  const quality = scoreQuality(
    await buildAnalysisInput(normalized.buffer, normalized.width, normalized.height, normalized.resized),
  );
  const sha256 = createHash('sha256').update(normalized.buffer).digest('hex');
  const key = buildKey(userId, 'jpg');
  const saved = await getStorage().save(key, normalized.buffer);

  try {
    const photo = getDb().transaction(() => {
      const inserted = insertPreprocessed({
        userId,
        sourcePhotoId: photoId,
        storageKey: key,
        mime: 'image/jpeg',
        bytes: saved.bytes,
        width: normalized.width,
        height: normalized.height,
        sha256,
        quality,
      });
      writeAudit({
        action: 'photo.preprocess',
        userId,
        target: `photo:${inserted.id}`,
        meta: { sourcePhotoId: photoId, usable: quality.usable, readability: quality.readability },
        createdAt: nowIso(),
      });
      return inserted;
    })();
    return { photo, quality };
  } catch (err) {
    await getStorage().delete(key).catch(() => undefined);
    throw err instanceof AppError ? err : appError('STORAGE_ERROR', { reason: String(err) });
  }
};

/** 一次提取最多送几张图（`docs/prd/modules/M03-身份锚点提取.md` §5.4；端点与 handler 两处都卡）。 */
export const ANCHOR_MAX_IMAGES = 5;

/** `identity_anchors` 行 → `Anchor` DTO（`docs/prd/spec/03-接口契约.md` §4）。 */
export const toAnchorDto = (
  record: AnchorRecord,
  photos: { sourcePhotos: Photo[]; preprocessedPhoto: Photo | null },
): Anchor => {
  const succeeded = record.status === 'succeeded';
  return {
    id: record.id,
    status: record.status,
    attempt: record.attempt,
    // `status !== 'succeeded'` 时两个产物字段必须为 null（§3.3）。
    anchorText: succeeded ? record.anchorText : null,
    features: succeeded ? record.features : null,
    model: record.model,
    promptVersion: record.promptVersion,
    quality: record.quality,
    confirmedByUser: record.confirmedByUser === 1,
    confirmedAt: record.confirmedAt,
    error:
      record.errorCode === null
        ? null
        : { code: record.errorCode, message: record.errorMessage ?? record.errorCode },
    sourcePhotos: photos.sourcePhotos,
    preprocessedPhoto: photos.preprocessedPhoto,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
  };
};

const toPhotoDtoOrNull = (photo: PhotoRecord | null): Photo | null =>
  photo === null ? null : toPhotoDto(photo);

const loadAnchorPhotos = (userId: number, record: AnchorRecord) => ({
  // 顺序跟 `input_photo_ids` 一致（前端按提交顺序展示）；已软删的行直接消失。
  sourcePhotos: record.inputPhotoIds
    .map((id) => findActivePhotoForUser(id, userId))
    .filter((photo): photo is PhotoRecord => photo !== null)
    .map(toPhotoDto),
  preprocessedPhoto: toPhotoDtoOrNull(
    record.preprocessedPhotoId === null ? null : findActivePhotoForUser(record.preprocessedPhotoId, userId),
  ),
});

export interface CreateAnchorInput {
  userId: number;
  photoIds: number[];
  preprocessedPhotoId: number | null;
}

/**
 * `POST /api/anchors`（`docs/prd/modules/M03-身份锚点提取.md` §4）：建 `queued` 行 + 同事务写
 * `audit_logs(action='anchor.extract')`；`preprocessedPhotoId` 缺省时同步对 `photoIds[0]` 做预处理。
 * 校验顺序按 `docs/prd/spec/03-接口契约.md` §3.3：张数 → 归属/存在 → `kind='generated'`。
 */
export const createAnchor = async (input: CreateAnchorInput): Promise<Anchor> => {
  const { userId, photoIds } = input;
  if (photoIds.length === 0 || photoIds.length > ANCHOR_MAX_IMAGES) {
    throw appError('INVALID_PARAM', {
      fields: { photoIds: [`需要 1–${ANCHOR_MAX_IMAGES} 张照片`] },
    });
  }

  // 存在性 / 归属 / 软删（任一不满足 → 404，不返回 403，API-04）；kind 校验在全部归属确认之后。
  const sources: PhotoRecord[] = [];
  for (const photoId of photoIds) {
    const photo = findActivePhotoForUser(photoId, userId);
    if (photo === null) throw appError('NOT_FOUND');
    sources.push(photo);
  }
  for (const photo of sources) {
    if (photo.kind === 'generated') {
      throw appError('INVALID_PARAM', {
        fields: { photoIds: ['结果图不能作为提取输入（防链式自举）'] },
      });
    }
  }

  let preprocessed: PhotoRecord;
  if (input.preprocessedPhotoId === null) {
    const main = sources[0];
    if (main === undefined) throw appError('INVALID_PARAM', { fields: { photoIds: ['至少一张照片'] } });
    preprocessed = (await preprocessPhoto(userId, main.id)).photo;
  } else {
    const photo = findActivePhotoForUser(input.preprocessedPhotoId, userId);
    if (photo === null) throw appError('NOT_FOUND');
    if (photo.kind !== 'preprocessed') {
      throw appError('INVALID_PARAM', {
        fields: { preprocessedPhotoId: ['必须是 kind=preprocessed 的照片'] },
      });
    }
    preprocessed = photo;
  }

  const createdAt = nowIso();
  const record = getDb().transaction(() => {
    const inserted = insert({
      userId,
      inputPhotoIds: photoIds,
      preprocessedPhotoId: preprocessed.id,
      status: 'queued',
      attempt: 0,
      model: arkVisionModel(),
      promptVersion: ANCHOR_PROMPT_VERSION,
      quality: null,
      createdAt,
    });
    writeAudit({
      action: 'anchor.extract',
      userId,
      target: `anchor:${inserted.id}`,
      meta: { photoIds, preprocessedPhotoId: preprocessed.id },
      createdAt,
    });
    return inserted;
  })();

  return toAnchorDto(record, {
    sourcePhotos: sources.map(toPhotoDto),
    preprocessedPhoto: toPhotoDto(preprocessed),
  });
};

/** `GET /api/anchors/:id`（§3.3）：不存在 / 属他人 → `ANCHOR_NOT_FOUND`（404）。 */
export const getAnchor = (userId: number, anchorId: number): Anchor => {
  const record = findByIdForUser(userId, anchorId);
  if (record === null) throw appError('ANCHOR_NOT_FOUND');
  return toAnchorDto(record, loadAnchorPhotos(userId, record));
};

/**
 * `POST /api/anchors/:id/retry`（§3.3）：**新建行**，`attempt = 旧 + 1`，继承 `inputPhotoIds` /
 * `preprocessedPhotoId`，旧行原样保留（`docs/prd/spec/01-领域模型与数据库.md` §2.1）。
 */
export const retryAnchor = (userId: number, anchorId: number): Anchor => {
  const previous = findByIdForUser(userId, anchorId);
  if (previous === null) throw appError('ANCHOR_NOT_FOUND');

  const createdAt = nowIso();
  const record = getDb().transaction(() => {
    const inserted = insert({
      userId,
      inputPhotoIds: previous.inputPhotoIds,
      preprocessedPhotoId: previous.preprocessedPhotoId,
      status: 'queued',
      attempt: previous.attempt + 1,
      model: arkVisionModel(),
      promptVersion: ANCHOR_PROMPT_VERSION,
      quality: null,
      createdAt,
    });
    writeAudit({
      action: 'anchor.extract',
      userId,
      target: `anchor:${inserted.id}`,
      meta: { retryOf: previous.id, attempt: inserted.attempt },
      createdAt,
    });
    return inserted;
  })();

  return toAnchorDto(record, loadAnchorPhotos(userId, record));
};
