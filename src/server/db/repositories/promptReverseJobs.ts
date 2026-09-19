import { getDb } from '../connection';
import { objectJson, parseJsonColumn } from '../json';
import type { Iso } from '../../../shared/types';

/**
 * `prompt_reverse_jobs` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.15、状态机 §2.4）。
 * 反推任务编排归 `tickets/T18`；`result_json` 的 zod 边界校验在 `tickets/T18` 补。
 */
export type ReverseJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface PromptReverseJobRecord {
  id: number;
  userId: number;
  sourcePhotoId: number;
  model: string;
  result: unknown;
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
  result: parseJsonColumn(row.result_json, objectJson, 'prompt_reverse_jobs.result_json'),
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

/** 落终态 `failed`（不可重试分支）：`attempt` 保持不变；`error_message` 存上游原文供排查。 */
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
