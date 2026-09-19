import { getDb } from '../connection';
import { parseJsonColumn } from '../json';
import { nowIso } from '../../domain/time';
import { qualitySchema, type Iso, type PhotoKind, type Quality } from '../../../shared/types';

/**
 * `photos` 表全部 SQL（`docs/prd/modules/M01-照片资产与存储.md` §5、`spec/01-领域模型与数据库.md` §3.4）。
 * 入参为原子值 / DTO，返回 camelCase 领域对象 `PhotoRecord`，**不返回数据库原始行**。
 * 写函数自带 `db.transaction`，可在 `domain/*Service` 的事务内安全嵌套。
 */
export interface PhotoRecord {
  id: number;
  userId: number;
  kind: PhotoKind;
  storageKey: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  sourcePhotoId: number | null;
  qualityJson: Quality | null;
  deletedAt: Iso | null;
  createdAt: Iso;
}

export interface NewPhoto {
  userId: number;
  kind: PhotoKind;
  storageKey: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  sourcePhotoId: number | null;
  qualityJson: Quality | null;
  createdAt: Iso;
}

interface PhotoRow {
  id: number;
  user_id: number;
  kind: PhotoKind;
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
  qualityJson: parseJsonColumn(row.quality_json, qualitySchema, 'photos.quality_json'),
  deletedAt: row.deleted_at,
  createdAt: row.created_at,
});

const INSERT_SQL = `
INSERT INTO photos (user_id, kind, storage_key, mime, bytes, width, height, sha256,
                    source_photo_id, quality_json, created_at)
VALUES (@userId, @kind, @storageKey, @mime, @bytes, @width, @height, @sha256,
        @sourcePhotoId, @qualityJson, @createdAt)`;

const bindNewPhoto = (input: NewPhoto) => ({
  ...input,
  qualityJson: input.qualityJson === null ? null : JSON.stringify(input.qualityJson),
});

const readBack = (id: number | bigint): PhotoRecord => {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM photos WHERE id = ?`).get(id) as
    | PhotoRow
    | undefined;
  if (row === undefined) throw new Error('photos 写入后读回失败');
  return toPhoto(row);
};

export const insertPhoto = (input: NewPhoto): PhotoRecord => {
  const db = getDb();
  return db.transaction(() => {
    const info = db.prepare(INSERT_SQL).run(bindNewPhoto(input));
    return readBack(info.lastInsertRowid);
  })();
};

/** 归属 + 软删除条件必须同一条 SQL（`modules/M01` §5：不允许先按 id 查再在 JS 里比对 `userId`）。 */
export const findActivePhotoForUser = (id: number, userId: number): PhotoRecord | null => {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM photos WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(id, userId) as PhotoRow | undefined;
  return row === undefined ? null : toPhoto(row);
};

/** 删除幂等所需的「不看软删状态」的归属读（`modules/M01` §6.3：已软删 → 200）。 */
export const findPhotoForUser = (id: number, userId: number): PhotoRecord | null => {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM photos WHERE id = ? AND user_id = ? LIMIT 1`)
    .get(id, userId) as PhotoRow | undefined;
  return row === undefined ? null : toPhoto(row);
};

/** 同用户内内容去重：只认未删除的 `original` 行（`modules/M01` §10.2 第 1 条）。 */
export const findActiveOriginalBySha256 = (userId: number, sha256: string): PhotoRecord | null => {
  const row = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM photos
       WHERE user_id = ? AND sha256 = ? AND kind = 'original' AND deleted_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(userId, sha256) as PhotoRow | undefined;
  return row === undefined ? null : toPhoto(row);
};

export const findOriginalById = (id: number, userId: number): PhotoRecord | null => {
  const row = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM photos
       WHERE id = ? AND user_id = ? AND kind = 'original' AND deleted_at IS NULL LIMIT 1`,
    )
    .get(id, userId) as PhotoRow | undefined;
  return row === undefined ? null : toPhoto(row);
};

/** 同一条原图只应有一张预处理图：取最新一张，且未软删。 */
export const findPreprocessedBySource = (sourcePhotoId: number): PhotoRecord | null => {
  const row = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM photos
       WHERE source_photo_id = ? AND kind = 'preprocessed' AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(sourcePhotoId) as PhotoRow | undefined;
  return row === undefined ? null : toPhoto(row);
};

export interface NewPreprocessed {
  userId: number;
  sourcePhotoId: number;
  storageKey: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  quality: Quality;
}

/** 插入 `kind='preprocessed'` 行；与原图存在性检查在同一事务（`modules/M01` §5）。 */
export const insertPreprocessed = (input: NewPreprocessed): PhotoRecord => {
  const db = getDb();
  return db.transaction(() => {
    const source = db
      .prepare("SELECT 1 FROM photos WHERE id = ? AND kind = 'original' AND deleted_at IS NULL")
      .get(input.sourcePhotoId);
    if (source === undefined) throw new Error(`原图 ${input.sourcePhotoId} 不存在或不可用`);
    const info = db
      .prepare(
        `INSERT INTO photos (user_id, kind, storage_key, mime, bytes, width, height, sha256,
                             source_photo_id, quality_json, created_at)
         VALUES (@userId, 'preprocessed', @storageKey, @mime, @bytes, @width, @height, @sha256,
                 @sourcePhotoId, @qualityJson, @createdAt)`,
      )
      .run({
        userId: input.userId,
        storageKey: input.storageKey,
        mime: input.mime,
        bytes: input.bytes,
        width: input.width,
        height: input.height,
        sha256: input.sha256,
        sourcePhotoId: input.sourcePhotoId,
        qualityJson: JSON.stringify(input.quality),
        createdAt: nowIso(),
      });
    return readBack(info.lastInsertRowid);
  })();
};

export const listActivePhotosByIds = (userId: number, ids: number[]): PhotoRecord[] => {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return (
    getDb()
      .prepare(
        `SELECT ${COLUMNS} FROM photos
         WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})
         ORDER BY created_at DESC, id DESC`,
      )
      .all(userId, ...ids) as PhotoRow[]
  ).map(toPhoto);
};

export const listActivePhotosByUser = (
  userId: number,
  opts: { limit: number; beforeCreatedAt?: Iso },
): PhotoRecord[] => {
  const db = getDb();
  if (opts.beforeCreatedAt === undefined) {
    return (
      db
        .prepare(
          `SELECT ${COLUMNS} FROM photos WHERE user_id = ? AND deleted_at IS NULL
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(userId, opts.limit) as PhotoRow[]
    ).map(toPhoto);
  }
  return (
    db
      .prepare(
        `SELECT ${COLUMNS} FROM photos WHERE user_id = ? AND deleted_at IS NULL AND created_at < ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(userId, opts.beforeCreatedAt, opts.limit) as PhotoRow[]
  ).map(toPhoto);
};

export const softDeletePhoto = (id: number, deletedAt: Iso): number => {
  const db = getDb();
  return db.transaction(() => {
    const info = db
      .prepare('UPDATE photos SET deleted_at = @deletedAt WHERE id = @id AND deleted_at IS NULL')
      .run({ id, deletedAt });
    return info.changes;
  })();
};

/** purge 扫描：`deleted_at` 早于阈值的行（`modules/M08-账号历史与彻底删除.md` §5.3）。 */
export const listPurgeCandidates = (deletedBefore: Iso, limit: number): PhotoRecord[] =>
  (
    getDb()
      .prepare(
        `SELECT ${COLUMNS} FROM photos WHERE deleted_at IS NOT NULL AND deleted_at < ?
         ORDER BY deleted_at ASC LIMIT ?`,
      )
      .all(deletedBefore, limit) as PhotoRow[]
  ).map(toPhoto);

export const hardDeletePhoto = (id: number): number => {
  const db = getDb();
  return db.transaction(() => db.prepare('DELETE FROM photos WHERE id = ?').run(id).changes)();
};
