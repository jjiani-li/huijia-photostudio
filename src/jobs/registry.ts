import { anchorExtractHandler } from './handlers/anchorExtract';

/**
 * 任务类型 → handler 的映射（`docs/prd/modules/M03-身份锚点提取.md` §2）。
 * 本条（`tickets/T06`）只有锚点提取；`tickets/T09` 追加生成与反推提示词两类。
 */
export interface JobPayloads {
  'anchor.extract': { anchorId: number };
}

export type JobType = keyof JobPayloads;

export type JobHandler<K extends JobType = JobType> = (job: JobPayloads[K]) => Promise<void>;

export const JOB_HANDLERS: { [K in JobType]: JobHandler<K> } = {
  'anchor.extract': anchorExtractHandler,
};
