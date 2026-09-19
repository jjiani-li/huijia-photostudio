import type { ErrorCode } from '../shared/types';
import * as anchorsRepo from '../server/db/repositories/anchors';
import * as generationsRepo from '../server/db/repositories/generations';
import * as reverseJobsRepo from '../server/db/repositories/promptReverseJobs';
import { nowIso } from '../server/domain/time';

/**
 * 任务失败处置（`docs/prd/spec/04-技术基线与目录结构.md` §4.6 是唯一事实源）：
 * 三张表同一套「零产出 + 瞬时错误 + `attempt < 1` → 回 `queued` 且 `attempt + 1`，否则落 `failed`」判据与写入。
 *
 * 单独成文件而不是放 `worker.ts`：`worker.ts` 与 `registry.ts` 互相依赖，把失败处置放进任一侧都会形成
 * `worker ↔ registry ↔ handlers/generate` 的循环导入；这里只依赖 repository，是两侧共同的底座。
 */
export type JobTable = 'identity_anchors' | 'prompt_reverse_jobs' | 'generations';

export interface JobFailureInput {
  table: JobTable;
  id: number;
  attempt: number;
  /** 本次成功转存并落库的结果数；`> 0` 时不得自动重试。 */
  produced: number;
  code: ErrorCode;
  /**
   * 落 `error_message` 的值。**由调用方决定语义**：需要把上游原文留库供排查时传原文，
   * 契约禁止把模型原文透给用户时（反推任务，`modules/M09-图片反推提示词.md` §5.4）传用户可见文案。
   */
  rawMessage: string;
  /**
   * 该错误在上游侧是否属瞬时可重试（`docs/prd/spec/04-技术基线与目录结构.md` §4.6 要求以
   * `modules/M06-生成编排.md` §5.8 的「可重试」列为准，比 `AUTO_RETRY_ERROR_CODES` 更窄——
   * 例如 `ModelNotOpen` 落 `PROVIDER_ERROR` 但标 ❌）。缺省 `true`，即只按错误码集合判定。
   */
  retryable?: boolean;
}

/** 自动重试的瞬时错误集合（§4.6；`SQLITE_BUSY` 已映射为 `STORAGE_ERROR`）。 */
export const AUTO_RETRY_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_ERROR',
  'STORAGE_ERROR',
]);

/** `attempt` 达到该值后不再自动重试（只重试一次，§4.6）。 */
export const AUTO_RETRY_MAX_ATTEMPT = 1;

/** 判据：零产出 + 错误码在瞬时集合内 + `attempt < 1`。 */
export const isAutoRetryable = (input: { code: ErrorCode; attempt: number; produced: number }): boolean =>
  input.produced === 0 && input.attempt < AUTO_RETRY_MAX_ATTEMPT && AUTO_RETRY_ERROR_CODES.has(input.code);

/** 三张表各自的失败写入（SQL 全部落在 repository 层）。 */
interface SettleOps {
  requeueForRetry(input: { id: number; attempt: number; code: ErrorCode; raw: string }): void;
  markFailed(input: { id: number; attempt: number; code: ErrorCode; raw: string; at: string }): void;
}

const SETTLE_OPS: Record<JobTable, SettleOps> = {
  identity_anchors: {
    requeueForRetry: ({ id, attempt, code, raw }) => anchorsRepo.requeueForRetry(id, attempt, code, raw),
    markFailed: ({ id, code, raw, at }) =>
      anchorsRepo.markFailed({ id, errorCode: code, errorMessage: raw, quality: null, finishedAt: at }),
  },
  prompt_reverse_jobs: {
    requeueForRetry: ({ id, attempt, code, raw }) => reverseJobsRepo.requeueForRetry(id, attempt, code, raw),
    markFailed: ({ id, code, raw, at }) => reverseJobsRepo.markTerminalFailure(id, code, raw, at),
  },
  generations: {
    requeueForRetry: ({ id, attempt, code, raw }) =>
      generationsRepo.updateStatus({
        id,
        status: 'queued',
        attempt,
        errorCode: code,
        errorMessage: raw,
        startedAt: null,
        finishedAt: null,
      }),
    markFailed: ({ id, attempt, code, raw, at }) =>
      generationsRepo.updateStatus({
        id,
        status: 'failed',
        attempt,
        errorCode: code,
        errorMessage: raw,
        startedAt: null,
        finishedAt: at,
      }),
  },
};

/**
 * 失败处置的唯一入口：可重试 → 置回 `queued` 且 `attempt + 1`（`attempt` 只在重试时自增，
 * claim 阶段不动）；否则落终态 `failed`（`attempt` 保持不变）。
 *
 * `input.retryable === false` 时直接落终态（§4.6：可重试性以 `modules/M06` §5.8 的列为准）。
 *
 * 注意：本函数**不**做额度回滚与 `generation.finish` 审计——`generations` 的终态必须连同回滚与审计
 * 在同一事务内完成（`modules/M06-生成编排.md` §5.3/§5.6/§5.9⑥），那条路径由
 * `src/jobs/handlers/generate.ts` 的 `finalize()` 负责；本函数只服务 `identity_anchors` /
 * `prompt_reverse_jobs` 与「可重试 → 回 queued」这一半。
 */
export const settleJobFailure = (input: JobFailureInput): 'requeued' | 'failed' => {
  const ops = SETTLE_OPS[input.table];
  if (input.retryable !== false && isAutoRetryable(input)) {
    ops.requeueForRetry({ id: input.id, attempt: input.attempt + 1, code: input.code, raw: input.rawMessage });
    return 'requeued';
  }
  ops.markFailed({ id: input.id, attempt: input.attempt, code: input.code, raw: input.rawMessage, at: nowIso() });
  return 'failed';
};
