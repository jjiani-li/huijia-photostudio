import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { getDb } from '../db/connection';
import { AppError, appError } from './errors';
import { nowIso } from './time';
import { buildKey, getStorage, type ImageExt } from '../storage';
import { probeImage } from '../images/probe';
import { audit } from '../security/audit';
import { callModeration, recordModeration } from '../security/moderation';
import {
  findActiveOriginalBySha256,
  findActivePhotoForUser,
  findPhotoForUser,
  insertPhoto,
  softDeletePhoto,
  type PhotoRecord,
} from '../db/repositories/photos';
import type { Iso, Photo } from '../../shared/types';

/**
 * 照片上传 / 读图的编排与事务边界（`docs/prd/modules/M01-照片资产与存储.md` §6）。
 * `DELETE` 只做最小软删 + 审计；级联软删与 `runPurge()` 归 `tickets/T13`。
 */
const MIME_EXT: Record<string, ImageExt> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/** 上传阶段内容审核被拒前的级联计数（`spec/03-接口契约.md` §3.2）；本模块恒为零。 */
export interface Cascaded {
  preprocessed: number;
  anchors: number;
  generations: number;
  results: number;
}

const ZERO_CASCADE: Cascaded = { preprocessed: 0, anchors: 0, generations: 0, results: 0 };

const maxUploadBytes = (): number => Number(process.env.MAX_UPLOAD_MB ?? 20) * 1024 * 1024;

/** `photos` 行 → `Photo` DTO；`url` 固定由服务端拼（`spec/03-接口契约.md` §3.2）。 */
export const toPhotoDto = (record: PhotoRecord): Photo => ({
  id: record.id,
  kind: record.kind,
  url: `/api/photos/${record.id}/file`,
  mime: record.mime,
  bytes: record.bytes,
  width: record.width,
  height: record.height,
  sha256: record.sha256,
  createdAt: record.createdAt,
});

/** `File` 的最小形状（避免在 Node 侧依赖 DOM 的 `File` 类型）。 */
export interface UploadFile {
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

const asStorageError = (err: unknown): AppError =>
  err instanceof AppError ? err : appError('STORAGE_ERROR', { reason: String(err) });

/**
 * `POST /api/photos`（`modules/M01` §6.1）：校验 → buffer → sha256 → 去重 → 原子落盘 → 单事务三写。
 * 事务失败回滚磁盘并抛 `STORAGE_ERROR`。
 */
export const uploadPhoto = async (params: { userId: number; file: UploadFile }): Promise<PhotoRecord> => {
  const { userId, file } = params;
  const maxBytes = maxUploadBytes();
  if (file.size > maxBytes) throw appError('FILE_TOO_LARGE', { size: file.size, maxBytes });
  const ext = MIME_EXT[file.type];
  if (ext === undefined) throw appError('INVALID_FILE_TYPE', { type: file.type });

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw appError('FILE_TOO_LARGE', { size: buffer.byteLength, maxBytes });
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const createdAt = nowIso();
  const db = getDb();

  // 同用户内内容去重：命中不落盘、不新增行，但仍调上传阶段审核并补写 content_reviews + audit_logs（deduped: true）。
  const existing = findActiveOriginalBySha256(userId, sha256);
  if (existing !== null) {
    // 模型调用在事务外先跑完（异步），判定落库 + `photo.upload` 审计 + `reject` 软删放进**同一事务**
    // （`modules/M01` §5.6 的去重分支要求），与下面的新建分支保持同一写法。
    const dedupDecision = await callModeration({
      stage: 'upload',
      image: { mime: existing.mime, base64: buffer.toString('base64') },
    });
    db.transaction(() => {
      audit(
        {
          action: 'photo.upload',
          userId,
          target: `photo:${existing.id}`,
          meta: { mime: existing.mime, bytes: existing.bytes, sha256, deduped: true },
        },
        createdAt,
      );
      recordModeration({
        userId,
        stage: 'upload',
        targetType: 'photo',
        targetId: existing.id,
        decision: dedupDecision,
        now: createdAt,
      });
      if (dedupDecision.verdict === 'reject') softDeletePhoto(existing.id, createdAt);
    })();
    if (dedupDecision.verdict === 'reject') throw appError('CONTENT_REJECTED');
    return existing;
  }

  // 上传阶段审核的**模型调用**（`modules/M07` §5.6 的 `upload` 行）：异步，必须在事务之外先跑完；
  // 判定落库（`content_reviews` + `moderation.reject`）随后放进同一个事务里（§5.6 的三写一致性）。
  // 失败即视为未审核 → 不放过：不落盘、不建行，按上游映射抛出。
  const decision = await callModeration({
    stage: 'upload',
    image: { mime: file.type, base64: buffer.toString('base64') },
  });

  const key = buildKey(userId, ext);
  const storage = getStorage();
  const saved = await storage.save(key, buffer);

  let width: number | null;
  let height: number | null;
  try {
    ({ width, height } = await probeImage(buffer));
  } catch (err) {
    await storage.delete(key).catch(() => undefined);
    throw err; // probeImage 已按 §6.4 分类为 INVALID_FILE_TYPE / STORAGE_ERROR
  }

  // 单事务三写（`modules/M01` §5.6）：`photos` 行 + `photo.upload` 审计 + 审核判定（`content_reviews`）；
  // `reject` 时在同一事务内立即软删该行（磁盘文件由 `runPurge()` 清理）并写 `moderation.reject` 审计。
  let photo: PhotoRecord;
  try {
    photo = db.transaction(() => {
      const inserted = insertPhoto({
        userId,
        kind: 'original',
        storageKey: key,
        mime: file.type,
        bytes: saved.bytes,
        width,
        height,
        sha256,
        sourcePhotoId: null,
        qualityJson: null,
        createdAt,
      });
      audit(
        {
          action: 'photo.upload',
          userId,
          target: `photo:${inserted.id}`,
          meta: { mime: inserted.mime, bytes: inserted.bytes, sha256, deduped: false },
        },
        createdAt,
      );
      recordModeration({
        userId,
        stage: 'upload',
        targetType: 'photo',
        targetId: inserted.id,
        decision,
        now: createdAt,
      });
      if (decision.verdict === 'reject') softDeletePhoto(inserted.id, createdAt);
      return inserted;
    })();
  } catch (err) {
    await storage.delete(key).catch(() => undefined);
    throw asStorageError(err);
  }

  // 软删与审计已随事务提交；在事务内 `throw` 会把它们一起回滚，所以 422 在提交之后再抛。
  if (decision.verdict === 'reject') throw appError('CONTENT_REJECTED');
  return photo;
};

export interface PhotoBinary {
  body: Buffer;
  contentType: string;
  generated: boolean;
}

/** `GET /api/photos/:id/file`（`modules/M01` §6.2）：归属与软删校验 → 可选缩放 → 二进制。 */
export const readPhotoForUser = async (params: {
  userId: number;
  photoId: number;
  width?: number;
}): Promise<PhotoBinary> => {
  const photo = findActivePhotoForUser(params.photoId, params.userId);
  if (photo === null) throw appError('NOT_FOUND'); // 不存在 / 他人 / 已软删三者共用 404（API-04）
  const buffer = await getStorage().read(photo.storageKey);
  const generated = photo.kind === 'generated';
  if (params.width === undefined) {
    return { body: buffer, contentType: photo.mime, generated };
  }
  // 永不放大（`withoutEnlargement`，spec/00 §4 红线）。
  const resized = await sharp(buffer)
    .resize({ width: params.width, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { body: resized, contentType: 'image/jpeg', generated };
};

/** `DELETE /api/photos/:id`（`modules/M01` §6.3）：软删 + 审计；级联计数归 `tickets/T13`。 */
export const deletePhoto = (params: {
  userId: number;
  photoId: number;
}): { ok: true; cascaded: Cascaded } => {
  const db = getDb();
  return db.transaction(() => {
    const photo = findPhotoForUser(params.photoId, params.userId);
    if (photo === null) throw appError('NOT_FOUND');
    if (photo.deletedAt !== null) return { ok: true as const, cascaded: ZERO_CASCADE };
    const deletedAt: Iso = nowIso();
    softDeletePhoto(photo.id, deletedAt);
    audit(
      {
        action: 'photo.delete',
        userId: params.userId,
        target: `photo:${photo.id}`,
      },
      deletedAt,
    );
    return { ok: true as const, cascaded: ZERO_CASCADE };
  })();
};
