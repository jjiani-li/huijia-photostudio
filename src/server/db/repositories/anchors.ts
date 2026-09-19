import { getDb } from '../connection';
import type { Iso } from '../../../shared/types';

/**
 * `identity_anchors` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.5、状态机 §2.1）。
 * 提取 / 确认 / 重试编排归 `tickets/T06`、`tickets/T07`；本文件提供 SQL 底座。
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
  features: unknown;
  model: string;
  promptVersion: string;
  quality: unknown;
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

const parseJson = (value: string | null): unknown => (value === null ? null : (JSON.parse(value) as unknown));

const toAnchor = (row: AnchorRow): AnchorRecord => ({
  id: row.id,
  userId: row.user_id,
  inputPhotoIds: JSON.parse(row.input_photo_ids) as number[],
  preprocessedPhotoId: row.preprocessed_photo_id,
  status: row.status,
  attempt: row.attempt,
  anchorText: row.anchor_text,
  features: parseJson(row.features_json),
  model: row.model,
  promptVersion: row.prompt_version,
  quality: parseJson(row.quality_json),
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
  quality: unknown;
  createdAt: Iso;
}

export const insert = (input: InsertAnchorInput): AnchorRecord => {
  const info = getDb()
    .prepare(
      `INSERT INTO identity_anchors (user_id, input_photo_ids, preprocessed_photo_id, status,
                                     attempt, model, prompt_version, quality_json, created_at)
       VALUES (@userId, @inputPhotoIds, @preprocessedPhotoId, @status, @attempt, @model,
               @promptVersion, @qualityJson, @createdAt)`,
    )
    .run({
      ...input,
      inputPhotoIds: JSON.stringify(input.inputPhotoIds),
      qualityJson: input.quality === null || input.quality === undefined ? null : JSON.stringify(input.quality),
    });
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM identity_anchors WHERE id = ?`).get(info.lastInsertRowid) as
    | AnchorRow
    | undefined;
  if (row === undefined) throw new Error('identity_anchors 插入后读回失败');
  return toAnchor(row);
};

/** 强制确认节点：仅 0→1 落值，重复确认不改 `confirmed_at`（`docs/prd/modules/M04-身份确认与授权.md` §5.1 ⑥）。 */
export const markConfirmed = (id: number, confirmedAt: Iso): void => {
  getDb()
    .prepare(
      `UPDATE identity_anchors SET confirmed_by_user = 1,
               confirmed_at = COALESCE(confirmed_at, @confirmedAt)
       WHERE id = @id AND confirmed_by_user = 0`,
    )
    .run({ id, confirmedAt });
};
