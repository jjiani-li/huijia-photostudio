import { getDb } from '../connection';
import { placeholders } from '../sql';
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

/** `ordinal` 升序；宽高取转存后实测的 `photos.width` / `photos.height`（`modules/M06` §5.9 ③）。
 *  `p.deleted_at IS NULL`：单张 `kind='generated'` 被软删后（`modules/M08` §3.3 的 `generated` 行
 *  「结果行保留」），历史 / 详情不得再返回指向 404 的结果（`spec/03-接口契约.md` §3.6「只返回未软删除的照片」）。 */
export const listResultsByGeneration = (generationId: number): GenerationResultRecord[] =>
  (
    getDb()
      .prepare(
        `SELECT ${RESULT_COLUMNS} FROM generation_results r
         JOIN photos p ON p.id = r.photo_id
         WHERE r.generation_id = ? AND p.deleted_at IS NULL
         ORDER BY r.ordinal ASC`,
      )
      .all(generationId) as GenerationResultRow[]
  ).map(toResult);

export interface InsertResultInput {
  generationId: number;
  photoId: number;
  ordinal: number;
  seed: number | null;
  /** 年代复核快照（`tickets/T11`）：复核成功才非空，失败/未跑为 `NULL`。 */
  eraCheck: EraCheck | null;
  /** 年龄偏差（有符号整数，负 = 变年轻）：不可计算为 `NULL`（`modules/M07` §5.4）。 */
  ageDelta: number | null;
  createdAt: Iso;
}

/**
 * 插一行结果（`modules/M06` §5.9 ⑤）：`ordinal` 由调用方按产出顺序给 0..n-1 连续值。
 * `era_check_json` / `age_delta` 由 `tickets/T11` 的复核产出后随行写入；`realism_score` 本期恒 `NULL`。
 */
export const insertResult = (input: InsertResultInput): void => {
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `INSERT INTO generation_results (generation_id, photo_id, ordinal, seed, era_check_json, age_delta, created_at)
           VALUES (@generationId, @photoId, @ordinal, @seed, @eraCheckJson, @ageDelta, @createdAt)`,
        )
        .run({
          ...input,
          eraCheckJson: input.eraCheck === null ? null : JSON.stringify(input.eraCheck),
        }),
    )();
};

/**
 * 自动重试：零产出的瞬时失败 → 回到 `queued` 且 `attempt` 自增（`modules/M06` §5.5、`spec/04` §4.6）。
 * 与 `anchors.ts` 的 `requeueForRetry` 同一写法（worker 的 `SETTLE_OPS.generations` 用 `updateStatus`
 * 表达同一状态，两处语义一致）。
 */
export const requeueForRetry = (id: number, attempt: number, errorCode: string, errorMessage: string): void => {
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE generations SET status = 'queued', attempt = @attempt, error_code = @errorCode,
                  error_message = @errorMessage, started_at = NULL, finished_at = NULL
           WHERE id = @id`,
        )
        .run({ id, attempt, errorCode, errorMessage }),
    )();
};

// ── `tickets/T13`：历史分页、级联解析与反馈写入的批量 SQL ─────────────────────────────

/** 受影响 `generations` id（`modules/M08` §3.3 第 ③ 步：`anchor_id IN (:anchorIds)`）。 */
export const listIdsByAnchorIds = (anchorIds: number[]): number[] => {
  if (anchorIds.length === 0) return [];
  return (
    getDb()
      .prepare(`SELECT id FROM generations WHERE anchor_id IN (${placeholders(anchorIds.length)})`)
      .all(...anchorIds) as { id: number }[]
  ).map((row) => row.id);
};

/**
 * 每锚点最近 `perAnchor` 条（`modules/M08` §3.4 的窗口函数）：`/api/history` 的
 * `HistoryItem.generations` 用它取「最近 10 条」。返回记录按 `(anchor_id, created_at DESC, id DESC)`。
 */
export const listRecentByAnchors = (
  userId: number,
  anchorIds: number[],
  perAnchor: number,
): GenerationRecord[] => {
  if (anchorIds.length === 0) return [];
  const sql = `
    SELECT ${COLUMNS} FROM (
      SELECT g.*, ROW_NUMBER() OVER (PARTITION BY g.anchor_id ORDER BY g.created_at DESC, g.id DESC) AS rn
      FROM generations g WHERE g.user_id = ? AND g.anchor_id IN (${placeholders(anchorIds.length)})
    ) WHERE rn <= ?`;
  return (
    getDb()
      .prepare(sql)
      .all(userId, ...anchorIds, perAnchor) as GenerationRow[]
  ).map(toGeneration);
};

/** 批量物理 DELETE `generations`（`modules/M08` §3.3），返回命中行数。 */
export const hardDeleteGenerations = (ids: number[]): number => {
  if (ids.length === 0) return 0;
  const db = getDb();
  return db.transaction(
    () =>
      db.prepare(`DELETE FROM generations WHERE id IN (${placeholders(ids.length)})`).run(...ids).changes,
  )();
};

/** `generation_results` 行数（`cascaded.results` 在删除前记数，`modules/M08` §5.2）。 */
export const countResultsByGenerationIds = (generationIds: number[]): number => {
  if (generationIds.length === 0) return 0;
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM generation_results WHERE generation_id IN (${placeholders(generationIds.length)})`,
      )
      .get(...generationIds) as { n: number }
  ).n;
};

/** 批量物理 DELETE `generation_results`（与 `generations` 同一事务，`spec/01` §2.3），返回命中行数。 */
export const deleteResultsByGenerationIds = (generationIds: number[]): number => {
  if (generationIds.length === 0) return 0;
  const db = getDb();
  return db.transaction(
    () =>
      db
        .prepare(`DELETE FROM generation_results WHERE generation_id IN (${placeholders(generationIds.length)})`)
        .run(...generationIds).changes,
  )();
};

/** 兜底清理孤儿结果行（`modules/M08` §5.3 步骤 ③），返回命中行数。 */
export const deleteOrphanResults = (): number =>
  getDb()
    .transaction(
      () =>
        getDb()
          .prepare('DELETE FROM generation_results WHERE generation_id NOT IN (SELECT id FROM generations)')
          .run().changes,
    )();

/** 结果行的归属读（`POST /api/results/:id/feedback`）：不是自己的资源一律 `null` → `404`。 */
export const findResultForUser = (userId: number, resultId: number): GenerationResultRecord | null => {
  const row = getDb()
    .prepare(
      `SELECT ${RESULT_COLUMNS} FROM generation_results r
       JOIN photos p ON p.id = r.photo_id
       JOIN generations g ON g.id = r.generation_id
       WHERE r.id = ? AND g.user_id = ?`,
    )
    .get(resultId, userId) as GenerationResultRow | undefined;
  return row === undefined ? null : toResult(row);
};

/** 写 `generation_results.user_feedback`（`spec/03-接口契约.md` §3.5）；`null` 表示清除反馈。 */
export const updateResultFeedback = (resultId: number, feedback: number | null): void => {
  getDb()
    .transaction(() =>
      getDb()
        .prepare('UPDATE generation_results SET user_feedback = @feedback WHERE id = @resultId')
        .run({ resultId, feedback }),
    )();
};
