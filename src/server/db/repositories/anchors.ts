import { getDb } from '../connection';
import { idArrayJson, parseJsonColumn, parseRequiredJsonColumn } from '../json';
import {
  anchorFeaturesSchema,
  qualitySchema,
  type AnchorFeatures,
  type Iso,
  type Quality,
} from '../../../shared/types';

/**
 * `identity_anchors` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.5、状态机 §2.1）。
 * 提取 / 确认 / 重试编排归 `tickets/T06`、`tickets/T07`；本文件提供 SQL 底座。
 * 写函数自带 `db.transaction`，可在 `domain/*Service` 的事务内安全嵌套。
 * `features_json` 的 12 键边界校验用 `src/shared/types.ts` 的唯一 schema（多余键 `strip`）。
 */
export type AnchorStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface AnchorRecord {
  id: number;
  userId: number;
  inputPhotoIds: number[];
  preprocessedPhotoId: number | null;
  status: AnchorStatus;
  attempt: number;
  anchorText: string | null;
  features: AnchorFeatures | null;
  model: string;
  promptVersion: string;
  quality: Quality | null;
  errorCode: string | null;
  errorMessage: string | null;
  confirmedByUser: number;
  confirmedAt: Iso | null;
  createdAt: Iso;
  startedAt: Iso | null;
  finishedAt: Iso | null;
}

interface AnchorRow {
  id: number;
  user_id: number;
  input_photo_ids: string;
  preprocessed_photo_id: number | null;
  status: AnchorStatus;
  attempt: number;
  anchor_text: string | null;
  features_json: string | null;
  model: string;
  prompt_version: string;
  quality_json: string | null;
  error_code: string | null;
  error_message: string | null;
  confirmed_by_user: number;
  confirmed_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const COLUMNS =
  'id, user_id, input_photo_ids, preprocessed_photo_id, status, attempt, anchor_text, features_json, model, prompt_version, quality_json, error_code, error_message, confirmed_by_user, confirmed_at, created_at, started_at, finished_at';

const toAnchor = (row: AnchorRow): AnchorRecord => ({
  id: row.id,
  userId: row.user_id,
  inputPhotoIds: parseRequiredJsonColumn(row.input_photo_ids, idArrayJson, 'identity_anchors.input_photo_ids'),
  preprocessedPhotoId: row.preprocessed_photo_id,
  status: row.status,
  attempt: row.attempt,
  anchorText: row.anchor_text,
  features: parseJsonColumn(row.features_json, anchorFeaturesSchema, 'identity_anchors.features_json'),
  model: row.model,
  promptVersion: row.prompt_version,
  quality: parseJsonColumn(row.quality_json, qualitySchema, 'identity_anchors.quality_json'),
  errorCode: row.error_code,
  errorMessage: row.error_message,
  confirmedByUser: row.confirmed_by_user,
  confirmedAt: row.confirmed_at,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export const findById = (id: number): AnchorRecord | null => {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM identity_anchors WHERE id = ?`).get(id) as
    | AnchorRow
    | undefined;
  return row === undefined ? null : toAnchor(row);
};

export const findByIdForUser = (userId: number, id: number): AnchorRecord | null => {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM identity_anchors WHERE id = ? AND user_id = ?`)
    .get(id, userId) as AnchorRow | undefined;
  return row === undefined ? null : toAnchor(row);
};

export const listByUser = (userId: number): AnchorRecord[] =>
  (
    getDb()
      .prepare(`SELECT ${COLUMNS} FROM identity_anchors WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as AnchorRow[]
  ).map(toAnchor);

export interface InsertAnchorInput {
  userId: number;
  inputPhotoIds: number[];
  preprocessedPhotoId: number | null;
  status: AnchorStatus;
  attempt: number;
  model: string;
  promptVersion: string;
  quality: Quality | null;
  createdAt: Iso;
}

export const insert = (input: InsertAnchorInput): AnchorRecord => {
  const db = getDb();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO identity_anchors (user_id, input_photo_ids, preprocessed_photo_id, status,
                                       attempt, model, prompt_version, quality_json, created_at)
         VALUES (@userId, @inputPhotoIds, @preprocessedPhotoId, @status, @attempt, @model,
                 @promptVersion, @qualityJson, @createdAt)`,
      )
      .run({
        ...input,
        inputPhotoIds: JSON.stringify(input.inputPhotoIds),
        qualityJson: input.quality === null ? null : JSON.stringify(input.quality),
      });
    const row = db.prepare(`SELECT ${COLUMNS} FROM identity_anchors WHERE id = ?`).get(info.lastInsertRowid) as
      | AnchorRow
      | undefined;
    if (row === undefined) throw new Error('identity_anchors 插入后读回失败');
    return toAnchor(row);
  })();
};

/**
 * claim（`docs/prd/modules/M03-身份锚点提取.md` §3 的 claim 行）：仅把 `queued` 推进到 `running`。
 * 返回 `changes`——`0` 表示没抢到（已被别的 worker 取走或已是终态），调用方必须直接放弃本轮。
 */
export const claimForRun = (id: number, startedAt: Iso): number => {
  const db = getDb();
  return db.transaction(
    () =>
      db
        .prepare(
          `UPDATE identity_anchors SET status = 'running', started_at = @startedAt
           WHERE id = @id AND status = 'queued'`,
        )
        .run({ id, startedAt }).changes,
  )();
};

export interface MarkSucceededInput {
  id: number;
  anchorText: string;
  features: AnchorFeatures;
  quality: Quality | null;
  preprocessedPhotoId: number | null;
  finishedAt: Iso;
}

/** 成功落库（§3 的「成功」行）：`anchor_text` / `features_json` 必须非空，同时清掉上一次的错误码。 */
export const markSucceeded = (input: MarkSucceededInput): void => {
  const db = getDb();
  db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE identity_anchors
         SET status = 'succeeded', anchor_text = @anchorText, features_json = @featuresJson,
             quality_json = @qualityJson, preprocessed_photo_id = @preprocessedPhotoId,
             error_code = NULL, error_message = NULL, finished_at = @finishedAt
         WHERE id = @id`,
      )
      .run({
        id: input.id,
        anchorText: input.anchorText,
        featuresJson: JSON.stringify(input.features),
        qualityJson: input.quality === null ? null : JSON.stringify(input.quality),
        preprocessedPhotoId: input.preprocessedPhotoId,
        finishedAt: input.finishedAt,
      });
    if (info.changes !== 1) throw new Error(`identity_anchors ${input.id} 成功落库失败`);
  })();
};

export interface MarkFailedInput {
  id: number;
  errorCode: string;
  errorMessage: string;
  quality: Quality | null;
  finishedAt: Iso;
}

/** 失败落库（§3 的「失败」行）：`error_code` 必须非空；`quality_json` 落质量快照（§6.1）。 */
export const markFailed = (input: MarkFailedInput): void => {
  const db = getDb();
  db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE identity_anchors
         SET status = 'failed', error_code = @errorCode, error_message = @errorMessage,
             quality_json = @qualityJson, finished_at = @finishedAt
         WHERE id = @id AND status = 'running'`,
      )
      .run({
        id: input.id,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        qualityJson: input.quality === null ? null : JSON.stringify(input.quality),
        finishedAt: input.finishedAt,
      });
    if (info.changes !== 1) throw new Error(`identity_anchors ${input.id} 失败落库失败`);
  })();
};

/** worker 拉取：一次只取一行（`docs/prd/spec/04-技术基线与目录结构.md` §4.6）。 */
export const findNextQueuedId = (): number | null => {
  const row = getDb()
    .prepare("SELECT id FROM identity_anchors WHERE status = 'queued' ORDER BY created_at LIMIT 1")
    .get() as { id: number } | undefined;
  return row === undefined ? null : row.id;
};

/** 强制确认节点：仅 0→1 落值，重复确认不改 `confirmed_at`（`docs/prd/modules/M04-身份确认与授权.md` §5.1 ⑥）。 */
export const markConfirmed = (id: number, confirmedAt: Iso): void => {
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE identity_anchors SET confirmed_by_user = 1,
                   confirmed_at = COALESCE(confirmed_at, @confirmedAt)
           WHERE id = @id AND confirmed_by_user = 0`,
        )
        .run({ id, confirmedAt }),
    )();
};
