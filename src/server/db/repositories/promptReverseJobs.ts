import { getDb } from '../connection';
import { placeholders } from '../sql';
import { parseJsonColumn } from '../json';
import { promptReverseDetailSchema, type Iso, type PromptReverseDetail } from '../../../shared/types';

/**
 * `prompt_reverse_jobs` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.15、状态机 §2.4）。
 * 反推任务编排归 `tickets/T18`；`result_json` 的五键 zod 边界校验也在本文件的读回路径上
 * （共用的 schema 定义在 `src/shared/types.ts`）。
 */
export type ReverseJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface PromptReverseJobRecord {
  id: number;
  userId: number;
  sourcePhotoId: number;
  model: string;
  result: PromptReverseDetail | null;
  resultPrompt: string | null;
  suggestEraCode: string | null;
  suggestSceneId: number | null;
  status: ReverseJobStatus;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Iso;
  startedAt: Iso | null;
  finishedAt: Iso | null;
}

interface PromptReverseJobRow {
  id: number;
  user_id: number;
  source_photo_id: number;
  model: string;
  result_json: string | null;
  result_prompt: string | null;
  suggest_era_code: string | null;
  suggest_scene_id: number | null;
  status: ReverseJobStatus;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const COLUMNS =
  'id, user_id, source_photo_id, model, result_json, result_prompt, suggest_era_code, suggest_scene_id, status, attempt, error_code, error_message, created_at, started_at, finished_at';

const toJob = (row: PromptReverseJobRow): PromptReverseJobRecord => ({
  id: row.id,
  userId: row.user_id,
  sourcePhotoId: row.source_photo_id,
  model: row.model,
  result: parseJsonColumn(row.result_json, promptReverseDetailSchema, 'prompt_reverse_jobs.result_json'),
  resultPrompt: row.result_prompt,
  suggestEraCode: row.suggest_era_code,
  suggestSceneId: row.suggest_scene_id,
  status: row.status,
  attempt: row.attempt,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export const findById = (id: number): PromptReverseJobRecord | null => {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM prompt_reverse_jobs WHERE id = ?`).get(id) as
    | PromptReverseJobRow
    | undefined;
  return row === undefined ? null : toJob(row);
};

/** `GET /api/prompt-reverse-jobs/:id` 用：他人或不存在一律读不到（`API-04`，不返回 403）。 */
export const findByIdForUser = (userId: number, id: number): PromptReverseJobRecord | null => {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM prompt_reverse_jobs WHERE id = ? AND user_id = ?`)
    .get(id, userId) as PromptReverseJobRow | undefined;
  return row === undefined ? null : toJob(row);
};

export const listByUser = (userId: number): PromptReverseJobRecord[] =>
  (
    getDb()
      .prepare(`SELECT ${COLUMNS} FROM prompt_reverse_jobs WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as PromptReverseJobRow[]
  ).map(toJob);

/** worker 拉取：一次只取一行（`docs/prd/spec/04-技术基线与目录结构.md` §4.6）。 */
export const findNextQueuedId = (): number | null => {
  const row = getDb()
    .prepare("SELECT id FROM prompt_reverse_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1")
    .get() as { id: number } | undefined;
  return row === undefined ? null : row.id;
};

/** claim（`spec/04-技术基线与目录结构.md` §4.6）：仅把 `queued` 推进到 `running`，`attempt` 不动。 */
export const claimForRun = (id: number, startedAt: Iso): number =>
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE prompt_reverse_jobs SET status = 'running', started_at = @startedAt
           WHERE id = @id AND status = 'queued'`,
        )
        .run({ id, startedAt }).changes,
    )();

/**
 * 启动回收（§4.6）：陈旧 `running` 行退回 `queued`、`started_at = NULL`；
 * `attempt` 保持不变、`error_code` 不写（`ERR-02`）。返回命中行数。
 */
export const requeueStale = (beforeIso: Iso): number =>
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE prompt_reverse_jobs SET status = 'queued', started_at = NULL
           WHERE status = 'running' AND started_at < @beforeIso`,
        )
        .run({ beforeIso }).changes,
    )();

/** 自动重试的入库（`spec/04` §4.6）：置回 `queued` 且 `attempt + 1`；`attempt` 只在重试时自增。 */
export const requeueForRetry = (id: number, attempt: number, errorCode: string, errorMessage: string): void => {
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE prompt_reverse_jobs SET status = 'queued', attempt = @attempt, error_code = @errorCode,
                  error_message = @errorMessage, started_at = NULL, finished_at = NULL
           WHERE id = @id`,
        )
        .run({ id, attempt, errorCode, errorMessage }),
    )();
};

/**
 * 落终态 `succeeded`（`modules/M09-图片反推提示词.md` §3）：`result_json` / `result_prompt` 非空，
 * 推荐值可空（越界已在 handler 归一为 `null`）。`error_code` / `error_message` 不写。
 *
 * `AND status = 'running'` 是竞态守卫：`JOB_TIMEOUT_SECONDS` 兜底可能已把该行落成终态，
 * 仍在飞的 handler 返回成功时不得覆盖它（`modules/M09` §5 的状态机）。返回命中行数。
 */
export interface MarkSucceededInput {
  id: number;
  result: PromptReverseDetail;
  resultPrompt: string;
  suggestEraCode: string | null;
  suggestSceneId: number | null;
  finishedAt: Iso;
}

export const markSucceeded = (input: MarkSucceededInput): number =>
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE prompt_reverse_jobs SET status = 'succeeded', result_json = @resultJson,
                  result_prompt = @resultPrompt, suggest_era_code = @suggestEraCode,
                  suggest_scene_id = @suggestSceneId, finished_at = @finishedAt
           WHERE id = @id AND status = 'running'`,
        )
        .run({
          id: input.id,
          resultJson: JSON.stringify(input.result),
          resultPrompt: input.resultPrompt,
          suggestEraCode: input.suggestEraCode,
          suggestSceneId: input.suggestSceneId,
          finishedAt: input.finishedAt,
        }).changes,
    )();

/** 落终态 `failed`（不可重试分支）：`attempt` 保持不变；`error_message` 存用户可见文案供排查。 */
export const markTerminalFailure = (
  id: number,
  errorCode: string,
  errorMessage: string,
  finishedAt: Iso,
): void => {
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE prompt_reverse_jobs SET status = 'failed', error_code = @errorCode, error_message = @errorMessage,
                  started_at = NULL, finished_at = @finishedAt
           WHERE id = @id`,
        )
        .run({ id, errorCode, errorMessage, finishedAt }),
    )();
};

export interface InsertPromptReverseJobInput {
  userId: number;
  sourcePhotoId: number;
  model: string;
  status: ReverseJobStatus;
  attempt: number;
  createdAt: Iso;
}

export const insert = (input: InsertPromptReverseJobInput): PromptReverseJobRecord => {
  const db = getDb();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO prompt_reverse_jobs (user_id, source_photo_id, model, status, attempt, created_at)
         VALUES (@userId, @sourcePhotoId, @model, @status, @attempt, @createdAt)`,
      )
      .run(input);
    const row = db
      .prepare(`SELECT ${COLUMNS} FROM prompt_reverse_jobs WHERE id = ?`)
      .get(info.lastInsertRowid) as PromptReverseJobRow | undefined;
    if (row === undefined) throw new Error('prompt_reverse_jobs 插入后读回失败');
    return toJob(row);
  })();
};

/**
 * 批量物理 DELETE（`docs/prd/modules/M08-账号历史与彻底删除.md` §3.3、§5.3）：反推任务按
 * `source_photo_id` 级联，返回命中行数。传 `userId` 时再加归属过滤（两个 `DELETE` 端点用）；
 * `runPurge()` 的批次（软删照片 id）只按照片 id。
 */
export const hardDeleteBySourcePhotos = (photoIds: number[], userId?: number): number => {
  if (photoIds.length === 0) return 0;
  const filter = userId === undefined ? '' : 'user_id = ? AND ';
  const params: number[] = userId === undefined ? photoIds : [userId, ...photoIds];
  const db = getDb();
  return db.transaction(
    () =>
      db
        .prepare(
          `DELETE FROM prompt_reverse_jobs WHERE ${filter}source_photo_id IN (${placeholders(photoIds.length)})`,
        )
        .run(...params).changes,
  )();
};
