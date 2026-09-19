import { findNextQueuedId as findNextAnchorId, markFailed } from '../server/db/repositories/anchors';
import {
  findById as findGenerationById,
  findNextQueuedId as findNextGenerationId,
} from '../server/db/repositories/generations';
import { findNextQueuedId as findNextReverseJobId } from '../server/db/repositories/promptReverseJobs';
import { ERROR_MESSAGE } from '../server/domain/errors';
import { nowIso } from '../server/domain/time';
import { anchorExtractHandler } from './handlers/anchorExtract';
import { failTimedOutGeneration, runGenerateJob } from './handlers/generate';
import { failTimedOutReverseJob, reversePromptHandler } from './handlers/reversePrompt';

/**
 * 任务类型 → handler 的映射，以及 worker 的三张任务表轮转来源
 * （`docs/prd/spec/04-技术基线与目录结构.md` §4.6 是唯一事实源）。
 *
 * 三张任务表的 handler 已齐（`tickets/T06` / `tickets/T10` / `tickets/T18`），轮转顺序不因此改变。
 */
export interface JobPayloads {
  'anchor.extract': { anchorId: number; signal: AbortSignal };
  generate: { generationId: number; signal: AbortSignal };
  'reverse.prompt': { jobId: number; signal: AbortSignal };
}

export type JobType = keyof JobPayloads;

export type JobHandler<K extends JobType = JobType> = (job: JobPayloads[K]) => Promise<void>;

/** 每个任务类型配它自己的 payload（不是把联合类型塞给单个 handler）。 */
export type JobHandlerMap = { [K in JobType]?: JobHandler<K> };

/** 每个任务类型配它的 handler；三张任务表都已就位。 */
export const JOB_HANDLERS: JobHandlerMap = {
  'anchor.extract': anchorExtractHandler,
  'reverse.prompt': reversePromptHandler,
  generate: async ({ generationId, signal }) => {
    const record = findGenerationById(generationId);
    if (record !== null) await runGenerateJob(record, signal);
  },
};

export interface TaskSource {
  jobType: JobType;
  /** `SELECT id FROM <表> WHERE status = 'queued' ORDER BY created_at LIMIT 1`。 */
  findNextQueuedId(): number | null;
  /** `JOB_TIMEOUT_SECONDS` 超时的兜底落库（只有锚点提取自带状态写入函数）。 */
  onTimeout?(id: number): void;
}

/**
 * 轮转顺序固定为 `identity_anchors → prompt_reverse_jobs → generations`
 * （§4.6 的公平性契约：任何一张都不会被另一张的长队列饿死）。
 */
export const TASK_SOURCES: TaskSource[] = [
  {
    jobType: 'anchor.extract',
    findNextQueuedId: findNextAnchorId,
    onTimeout: (id) =>
      markFailed({
        id,
        errorCode: 'PROVIDER_TIMEOUT',
        errorMessage: ERROR_MESSAGE.PROVIDER_TIMEOUT,
        quality: null,
        finishedAt: nowIso(),
      }),
  },
  { jobType: 'reverse.prompt', findNextQueuedId: findNextReverseJobId, onTimeout: failTimedOutReverseJob },
  {
    jobType: 'generate',
    findNextQueuedId: findNextGenerationId,
    // 超时兜底：仅对仍 `running` 的行生效，失败态连同额度回滚与 generation.finish（`tickets/T10`）。
    onTimeout: failTimedOutGeneration,
  },
];
