import { getDb } from '../connection';
import { idArrayJson, parseJsonColumn, parseRequiredJsonColumn } from '../json';
import {
  eraCheckSchema,
  generationParamsSchema,
  type EraCheck,
  type Generation,
  type Iso,
} from '../../../shared/types';

/**
 * `generations` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.9、状态机 §2.2）。
 * 8 步校验、单事务入队、worker 状态流转归 `tickets/T09`、`tickets/T10`、`tickets/T13`。
 * 写函数自带 `db.transaction`，可在 `domain/*Service` 的事务内安全嵌套。
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
  params: Generation['params'];
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
  referencePhotoIds: parseRequiredJsonColumn(
    row.reference_photo_ids,
    idArrayJson,
    'generations.reference_photo_ids',
  ),
  prompt: row.prompt,
  promptHash: row.prompt_hash,
  templateVersion: row.template_version,
  eraPackVersion: row.era_pack_version,
  scenePackVersion: row.scene_pack_version,
  model: row.model,
  params: parseRequiredJsonColumn(row.params_json, generationParamsSchema, 'generations.params_json'),
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

/** 归属读（`GET /api/generations/:id`、retry 的原任务）：不是自己的资源一律 `null` → `404`。 */
export const findByIdForUser = (userId: number, id: number): GenerationRecord | null => {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM generations WHERE id = ? AND user_id = ?`)
    .get(id, userId) as GenerationRow | undefined;
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
  params: Generation['params'];
  requestedCount: number;
  status: GenerationStatus;
  attempt: number;
  createdAt: Iso;
}

export const insert = (input: InsertGenerationInput): GenerationRecord => {
  const db = getDb();
  return db.transaction(() => {
    const info = db
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
    const row = db.prepare(`SELECT ${COLUMNS} FROM generations WHERE id = ?`).get(info.lastInsertRowid) as
      | GenerationRow
      | undefined;
    if (row === undefined) throw new Error('generations 插入后读回失败');
    return toGeneration(row);
  })();
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
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE generations SET status = @status, attempt = @attempt, error_code = @errorCode,
                   error_message = @errorMessage, started_at = @startedAt, finished_at = @finishedAt
           WHERE id = @id`,
        )
        .run(input),
    )();
};

/** worker 拉取：一次只取一行（`docs/prd/spec/04-技术基线与目录结构.md` §4.6）。 */
export const findNextQueuedId = (): number | null => {
  const row = getDb()
    .prepare("SELECT id FROM generations WHERE status = 'queued' ORDER BY created_at LIMIT 1")
    .get() as { id: number } | undefined;
  return row === undefined ? null : row.id;
};

/**
 * claim（`spec/04-技术基线与目录结构.md` §4.6，三张表同一写法）：仅把 `queued` 推进到 `running`，
 * `attempt` 不动。返回 `changes`——`0` 表示没抢到，调用方必须放弃本轮。供 `tickets/T10` 的 handler 调用。
 */
export const claimForRun = (id: number, startedAt: Iso): number =>
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE generations SET status = 'running', started_at = @startedAt
           WHERE id = @id AND status = 'queued'`,
        )
        .run({ id, startedAt }).changes,
    )();

/**
 * 启动回收（§4.6）：`running` 且 `started_at` 早于阈值的行退回 `queued`、`started_at = NULL`；
 * `attempt` 保持不变、`error_code` 不写（`ERR-02`）。返回命中行数。
 */
export const requeueStale = (beforeIso: Iso): number =>
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE generations SET status = 'queued', started_at = NULL
           WHERE status = 'running' AND started_at < @beforeIso`,
        )
        .run({ beforeIso }).changes,
    )();

// ── 结果行（`GET /api/generations/:id` 的 `results`；`spec/03-接口契约.md` §3.5）────────────

export interface GenerationResultRecord {
  id: number;
  generationId: number;
  photoId: number;
  ordinal: number;
  width: number | null;
  height: number | null;
  seed: number | null;
  eraCheck: EraCheck | null;
  ageDelta: number | null;
  realismScore: number | null;
  userFeedback: number | null;
  createdAt: Iso;
}

interface GenerationResultRow {
  id: number;
  generation_id: number;
  photo_id: number;
  ordinal: number;
  width: number | null;
  height: number | null;
  seed: number | null;
  era_check_json: string | null;
  age_delta: number | null;
  realism_score: number | null;
  user_feedback: number | null;
  created_at: string;
}

const RESULT_COLUMNS =
  'r.id, r.generation_id, r.photo_id, r.ordinal, r.seed, r.era_check_json, r.age_delta, r.realism_score, r.user_feedback, r.created_at, p.width, p.height';

const toResult = (row: GenerationResultRow): GenerationResultRecord => ({
  id: row.id,
  generationId: row.generation_id,
  photoId: row.photo_id,
  ordinal: row.ordinal,
  width: row.width,
  height: row.height,
  seed: row.seed,
  eraCheck: parseJsonColumn(row.era_check_json, eraCheckSchema, 'generation_results.era_check_json'),
  ageDelta: row.age_delta,
  realismScore: row.realism_score,
  userFeedback: row.user_feedback,
  createdAt: row.created_at,
});

/** `ordinal` 升序；宽高取转存后实测的 `photos.width` / `photos.height`（`modules/M06` §5.9 ③）。 */
export const listResultsByGeneration = (generationId: number): GenerationResultRecord[] =>
  (
    getDb()
      .prepare(
        `SELECT ${RESULT_COLUMNS} FROM generation_results r
         JOIN photos p ON p.id = r.photo_id
         WHERE r.generation_id = ?
         ORDER BY r.ordinal ASC`,
      )
      .all(generationId) as GenerationResultRow[]
  ).map(toResult);
