import { getDb } from '../connection';
import type { Iso } from '../../../shared/types';

/**
 * `photos` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.4）。
 * 上传 / 预处理 / 生成结果转存的写路径归 `tickets/T03`、`tickets/T04`、`tickets/T10`、`tickets/T13` 补齐。
 */
export interface PhotoRecord {
  id: number;
  userId: number;
  kind: 'original' | 'preprocessed' | 'generated';
  storageKey: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  sourcePhotoId: number | null;
  quality: unknown;
  deletedAt: Iso | null;
  createdAt: Iso;
}

interface PhotoRow {
  id: number;
  user_id: number;
  kind: PhotoRecord['kind'];
  storage_key: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  source_photo_id: number | null;
  quality_json: string | null;
  deleted_at: string | null;
  created_at: string;
}

const COLUMNS =
  'id, user_id, kind, storage_key, mime, bytes, width, height, sha256, source_photo_id, quality_json, deleted_at, created_at';

const toPhoto = (row: PhotoRow): PhotoRecord => ({
  id: row.id,
  userId: row.user_id,
  kind: row.kind,
  storageKey: row.storage_key,
  mime: row.mime,
  bytes: row.bytes,
  width: row.width,
  height: row.height,
  sha256: row.sha256,
  sourcePhotoId: row.source_photo_id,
  quality: row.quality_json === null ? null : (JSON.parse(row.quality_json) as unknown),
  deletedAt: row.deleted_at,
  createdAt: row.created_at,
});

export const findById = (id: number): PhotoRecord | null => {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM photos WHERE id = ?`).get(id) as
    | PhotoRow
    | undefined;
  return row === undefined ? null : toPhoto(row);
};

export const listActiveByUser = (userId: number): PhotoRecord[] =>
  (
    getDb()
      .prepare(`SELECT ${COLUMNS} FROM photos WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`)
      .all(userId) as PhotoRow[]
  ).map(toPhoto);

export interface InsertPhotoInput {
  userId: number;
  kind: PhotoRecord['kind'];
  storageKey: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  sourcePhotoId: number | null;
  quality: unknown;
  createdAt: Iso;
}

export const insert = (input: InsertPhotoInput): PhotoRecord => {
  const info = getDb()
    .prepare(
      `INSERT INTO photos (user_id, kind, storage_key, mime, bytes, width, height, sha256,
                           source_photo_id, quality_json, created_at)
       VALUES (@userId, @kind, @storageKey, @mime, @bytes, @width, @height, @sha256,
               @sourcePhotoId, @qualityJson, @createdAt)`,
    )
    .run({
      ...input,
      qualityJson: input.quality === null || input.quality === undefined ? null : JSON.stringify(input.quality),
    });
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM photos WHERE id = ?`).get(info.lastInsertRowid) as
    | PhotoRow
    | undefined;
  if (row === undefined) throw new Error('photos 插入后读回失败');
  return toPhoto(row);
};

/** 软删除：立即从所有读取路径消失，物理清理见 `modules/M08-账号历史与彻底删除.md` §5。 */
export const softDelete = (id: number, deletedAt: Iso): void => {
  getDb()
    .prepare('UPDATE photos SET deleted_at = @deletedAt WHERE id = @id AND deleted_at IS NULL')
    .run({ id, deletedAt });
};
