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
import { writeAudit } from '../security/audit';
import { buildAnalysisInput, normalize } from '../images/preprocess';
import { scoreQuality } from '../images/quality';
import type { Quality } from '../../shared/types';

/**
 * F1 前半段：预处理（`docs/prd/modules/M02-预处理与质量评分.md` §5.3）。
 * 唯一允许同时调 repository + `images/` + `storage/` 的地方。
 * 同一 `:id` 的并发请求用进程内单飞表去重（dev server 单进程，本期不引入分布式锁）。
 */
export interface PreprocessResult {
  photo: PhotoRecord;
  quality: Quality;
}

const inFlight = new Map<number, Promise<PreprocessResult>>();

export const preprocessPhoto = (userId: number, photoId: number): Promise<PreprocessResult> => {
  const running = inFlight.get(photoId);
  if (running !== undefined) return running;
  const task = doPreprocess(userId, photoId).finally(() => inFlight.delete(photoId));
  inFlight.set(photoId, task);
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
