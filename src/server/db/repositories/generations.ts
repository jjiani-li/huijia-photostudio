import { getDb } from '../connection';
import type { Iso } from '../../../shared/types';

/**
 * `generations` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.9、状态机 §2.2）。
 * 8 步校验、单事务入队、worker 状态流转归 `tickets/T09`、`tickets/T10`、`tickets/T13`。
 */
export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

export interface GenerationRecord {
  id: number;
  userId: number;
  anchorId: number;
  eraCode: string;
  sceneId: number;
  profileId: number | null;
  referencePhotoIds: number[];
  prompt: string;
  promptHash: string;
  templateVersion: string;
  eraPackVersion: string;
  scenePackVersion: string;
  model: string;
  params: unknown;
  requestedCount: number;
  status: GenerationStatus;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Iso;
  startedAt: Iso | null;
  finishedAt: Iso | null;
}

interface GenerationRow {
  id: number;
  user_id: number;
  anchor_id: number;
  era_code: string;
  scene_id: number;
  profile_id: number | null;
  reference_photo_ids: string;
  prompt: string;
  prompt_hash: string;
  template_version: string;
  era_pack_version: string;
  scene_pack_version: string;
  model: string;
  params_json: string;
  requested_count: number;
  status: GenerationStatus;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const COLUMNS =
  'id, user_id, anchor_id, era_code, scene_id, profile_id, reference_photo_ids, prompt, prompt_hash, template_version, era_pack_version, scene_pack_version, model, params_json, requested_count, status, attempt, error_code, error_message, created_at, started_at, finished_at';

const toGeneration = (row: GenerationRow): GenerationRecord => ({
  id: row.id,
  userId: row.user_id,
  anchorId: row.anchor_id,
  eraCode: row.era_code,
  sceneId: row.scene_id,
  profileId: row.profile_id,
  referencePhotoIds: JSON.parse(row.reference_photo_ids) as number[],
  prompt: row.prompt,
  promptHash: row.prompt_hash,
  templateVersion: row.template_version,
  eraPackVersion: row.era_pack_version,
  scenePackVersion: row.scene_pack_version,
  model: row.model,
  params: JSON.parse(row.params_json) as unknown,
  requestedCount: row.requested_count,
  status: row.status,
  attempt: row.attempt,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export const findById = (id: number): GenerationRecord | null => {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM generations WHERE id = ?`).get(id) as
    | GenerationRow
    | undefined;
  return row === undefined ? null : toGeneration(row);
};

export const listByUser = (userId: number): GenerationRecord[] =>
  (
    getDb()
      .prepare(`SELECT ${COLUMNS} FROM generations WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as GenerationRow[]
  ).map(toGeneration);

/** 非终态任务数（`modules/M06-生成编排.md` §5.2 第 ① 步排他检查）。 */
export const checkActiveByUser = (userId: number): number =>
  (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM generations WHERE user_id = ? AND status IN ('queued', 'running')",
      )
      .get(userId) as { n: number }
  ).n;

export interface InsertGenerationInput {
  userId: number;
  anchorId: number;
  eraCode: string;
  sceneId: number;
  profileId: number | null;
  referencePhotoIds: number[];
  prompt: string;
  promptHash: string;
  templateVersion: string;
  eraPackVersion: string;
  scenePackVersion: string;
  model: string;
  params: unknown;
  requestedCount: number;
  status: GenerationStatus;
  attempt: number;
  createdAt: Iso;
}

export const insert = (input: InsertGenerationInput): GenerationRecord => {
  const info = getDb()
    .prepare(
      `INSERT INTO generations (user_id, anchor_id, era_code, scene_id, profile_id,
                                reference_photo_ids, prompt, prompt_hash, template_version,
                                era_pack_version, scene_pack_version, model, params_json,
                                requested_count, status, attempt, created_at)
       VALUES (@userId, @anchorId, @eraCode, @sceneId, @profileId, @referencePhotoIds, @prompt,
               @promptHash, @templateVersion, @eraPackVersion, @scenePackVersion, @model,
               @paramsJson, @requestedCount, @status, @attempt, @createdAt)`,
    )
    .run({
      ...input,
      referencePhotoIds: JSON.stringify(input.referencePhotoIds),
      paramsJson: JSON.stringify(input.params),
    });
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM generations WHERE id = ?`).get(info.lastInsertRowid) as
    | GenerationRow
    | undefined;
  if (row === undefined) throw new Error('generations 插入后读回失败');
  return toGeneration(row);
};

export interface UpdateGenerationTerminalInput {
  id: number;
  status: GenerationStatus;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Iso | null;
  finishedAt: Iso | null;
}

/** 置终态 / 重新入队（worker 的状态流转，`modules/M06-生成编排.md` §5.3）。 */
export const updateStatus = (input: UpdateGenerationTerminalInput): void => {
  getDb()
    .prepare(
      `UPDATE generations SET status = @status, attempt = @attempt, error_code = @errorCode,
               error_message = @errorMessage, started_at = @startedAt, finished_at = @finishedAt
       WHERE id = @id`,
    )
    .run(input);
};
