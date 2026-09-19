import { getArk, mapArkError } from '../ark';
import type { SafetyReviewInput, SafetyReviewResult } from '../ark';
import { getDb } from '../db/connection';
import { insertContentReview } from '../db/repositories/reviews';
import { AppError, appError } from '../domain/errors';
import { nowIso } from '../domain/time';
import { audit } from './audit';
import type { Iso, ModerationVerdict } from '../../shared/types';

/**
 * 三阶段内容安全审核的**唯一入口**（`docs/prd/modules/M07-生成后复核与内容审核.md` §5.6）：
 * `moderateUpload()` / `moderatePrompt()` / `moderateResult()`——调上游审核、写 `content_reviews`
 * 一行、`reject` 时写 `audit_logs(action='moderation.reject')`。
 *
 * - **硬约束**：审核是合规硬约束，**不放过未审核的结果**——调用失败（超时 / 上游错误 / 无法解析）
 *   自动重试 1 次仍失败即抛错，绝不当作"通过"（`spec/06-合规与风控.md` §7）；
 * - **每个阶段无论判定为 `pass` / `review` / `reject` 都写恰好一行** `content_reviews`；
 * - `review` 三阶段都**等同放行**、仅留痕（无人工处置通道）。
 *
 * **为什么拆成"调用"与"落库"两步**：上游审核是异步调用，而 `better-sqlite3` 的事务是同步的
 * （`spec/04-技术基线与目录结构.md` §4.3）。上传路径的 `photos` 插入 + `content_reviews` + 审计
 * 必须落在同一个事务里（`modules/M01-照片资产与存储.md` §5.6 的三写一致性），因此把模型调用
 * `callModeration()` 提到事务之外，把落库 `recordModeration()` 交给调用方放进它自己的事务。
 *
 * **诚实说明**（`spec/06-合规与风控.md` §7）：本期用户输入面极小，`prompt` 阶段真正能拦到的只有
 * "模型从照片里读到的违规文字"间接进入 prompt，**是防线不是主力**；主力是 `upload` 与 `result`
 * 两个对着真实图像的阶段。
 */

/** 审核 prompt 版本（`modules/M07` §7 的代码内常量；`content_reviews` 无版本列，见 §9 决策 5）。 */
export const MODERATION_PROMPT_VERSION = 'moderation-v1';

export type ModerationStage = 'upload' | 'prompt' | 'result';

/** 审核判定取值域（与 `content_reviews.verdict` 一致，`spec/03-接口契约.md` §4）。 */
const VERDICTS: readonly ModerationVerdict[] = ['pass', 'review', 'reject'];

/** 审核 system prompt：三段共用一套输出契约，只按阶段说明"审什么"。 */
export const buildModerationPrompt = (stage: ModerationStage): string => {
  const target =
    stage === 'upload'
      ? '这张用户上传的照片'
      : stage === 'prompt'
        ? '这段用于生成图片的提示词文本'
        : '这张生成出来的图片';
  return [
    `你是内容安全审核模型，请判断${target}是否包含违规内容（裸露、暴力、违法、歧视性内容等）。`,
    `审核阶段标记：${stage}。`,
    '',
    '输出严格 JSON，不要 Markdown 代码块与解释文字：',
    '{ "verdict": "pass | review | reject", "reason": "一句话理由或 null" }',
    '判定口径：pass = 未见违规；review = 无法确认、建议人工留意（等同放行、仅留痕）；reject = 明确违规。',
  ].join('\n');
};

const CONTENT_LOG_LIMIT = 500;

const stripFence = (raw: string): string =>
  raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

/** 审核结论（`model` 取上游返回的模型名，落 `content_reviews.model`）。 */
export interface SafetyDecision {
  verdict: ModerationVerdict;
  reason: string | null;
  model: string | null;
}

/**
 * 审核正文 → 判定。无法解析为 JSON 对象、或 `verdict` 不在枚举内，一律抛 `PROVIDER_ERROR`
 * （`modules/M07` §6 的 `INTERNAL` 一行按同一路径处理）——**不得**把"没拿到结论"当作"通过"。
 * `reasonPrefix` 非空时前置到 `reason`（`prompt` 阶段的 `prompt-stage` 标记，`tickets/T11` §4 第 4 条）。
 */
export const parseSafetyVerdict = (raw: string, reasonPrefix?: string): { verdict: ModerationVerdict; reason: string | null } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    throw appError('PROVIDER_ERROR', { reason: 'moderation JSON.parse 失败' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw appError('PROVIDER_ERROR', { reason: 'moderation 返回体不是 JSON 对象' });
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as ModerationVerdict)) {
    throw appError('PROVIDER_ERROR', { reason: `moderation verdict 非枚举值：${String(verdict)}` });
  }
  const reason = typeof obj.reason === 'string' && obj.reason.trim() !== '' ? obj.reason : null;
  const prefixed =
    reasonPrefix === undefined ? reason : reason === null ? reasonPrefix : `${reasonPrefix}: ${reason}`;
  return { verdict: verdict as ModerationVerdict, reason: prefixed };
};

/** 上游异常 → `AppError`：`AppError` 原样透传，其余走 `mapArkError` 的唯一映射入口。 */
const toAppError = (err: unknown): AppError => {
  if (err instanceof AppError) return err;
  const mapped = mapArkError(err);
  return appError(mapped.code, { reason: mapped.raw.slice(0, CONTENT_LOG_LIMIT) });
};

const dataUri = (image: { mime: string; base64: string }): string => `data:${image.mime};base64,${image.base64}`;

export interface CallModerationParams {
  stage: ModerationStage;
  /** 图像阶段的待审图片；与 `text` 二选一。 */
  image?: { mime: string; base64: string };
  /** `prompt` 阶段的待审文本。 */
  text?: string;
  /** `prompt` 阶段的 `reason` 前缀。 */
  reasonPrefix?: string;
}

/**
 * **只调上游、不写库**（异步）：provider 调用 + 判定归一，失败自动重试 **1 次**
 * （`spec/03-接口契约.md` §2.2）；第二次仍失败即抛 `AppError`（`modules/M07` §6）。
 * 重试覆盖两类失败：上游异常（超时 / 报错）与正文无法解析成合法判定。
 * 落库交给 `recordModeration()`，使调用方能把它放进自己的同步事务（见文件头说明）。
 */
export const callModeration = async (params: CallModerationParams): Promise<SafetyDecision> => {
  const input: SafetyReviewInput = {
    stage: params.stage,
    systemPrompt: buildModerationPrompt(params.stage),
    image: params.image === undefined ? null : dataUri(params.image),
    text: params.text ?? null,
  };
  const decode = (result: SafetyReviewResult): SafetyDecision => {
    const { verdict, reason } = parseSafetyVerdict(result.raw, params.reasonPrefix);
    return { verdict, reason, model: result.model };
  };
  try {
    return decode(await getArk().reviewSafety(input));
  } catch {
    try {
      return decode(await getArk().reviewSafety(input));
    } catch (second) {
      throw toAppError(second);
    }
  }
};

export interface RecordModerationParams {
  userId: number;
  stage: ModerationStage;
  /** `content_reviews.target_type`，同时用于 `audit_logs.target` 前缀（`modules/M07` §3）。 */
  targetType: 'photo' | 'generation';
  targetId: number;
  decision: SafetyDecision;
  now?: Iso;
}

/**
 * **只写库、不调上游**（同步，可在调用方事务内嵌套）：写 `content_reviews` 一行；
 * `reject` 时同事务写 `audit_logs(action='moderation.reject')`（`meta_json` 记 `{stage, targetId, reason}`）。
 */
export const recordModeration = (params: RecordModerationParams): void => {
  const createdAt = params.now ?? nowIso();
  const db = getDb();
  db.transaction(() => {
    insertContentReview({
      userId: params.userId,
      stage: params.stage,
      targetType: params.targetType,
      targetId: params.targetId,
      verdict: params.decision.verdict,
      reason: params.decision.reason,
      model: params.decision.model,
      createdAt,
    });
    if (params.decision.verdict === 'reject') {
      audit(
        {
          action: 'moderation.reject',
          userId: params.userId,
          target: `${params.targetType}:${params.targetId}`,
          meta: { stage: params.stage, targetId: params.targetId, reason: params.decision.reason },
        },
        createdAt,
      );
    }
  })();
};

/**
 * `upload` 阶段（`POST /api/photos`，`modules/M07` §5.6）：审上传文件本身。
 * 判定为 `reject` 时由调用方软删 `photos` 行并返回 `422 CONTENT_REJECTED`。
 */
export const moderateUpload = async (params: {
  userId: number;
  photoId: number;
  image: { mime: string; base64: string };
  now?: Iso;
}): Promise<ModerationVerdict> => {
  const decision = await callModeration({ stage: 'upload', image: params.image });
  recordModeration({
    userId: params.userId,
    stage: 'upload',
    targetType: 'photo',
    targetId: params.photoId,
    decision,
    ...(params.now === undefined ? {} : { now: params.now }),
  });
  return decision.verdict;
};

/**
 * `prompt` 阶段（`POST /api/generations` 的"拼装完成 → 入队前"）：审拼装后的 prompt 全文。
 * `target_id` 用占位 `0` 并在 `reason` 前置 `prompt-stage`（`modules/M07` §9 待定决策 2，本期已决策）。
 */
export const moderatePrompt = async (params: {
  userId: number;
  prompt: string;
  now?: Iso;
}): Promise<ModerationVerdict> => {
  const decision = await callModeration({ stage: 'prompt', text: params.prompt, reasonPrefix: 'prompt-stage' });
  recordModeration({
    userId: params.userId,
    stage: 'prompt',
    targetType: 'generation',
    targetId: 0,
    decision,
    ...(params.now === undefined ? {} : { now: params.now }),
  });
  return decision.verdict;
};

/**
 * `result` 阶段（worker 转存候选图之后，`modules/M07` §5.1 ②）：审生成图。
 * 判定为 `reject` 时由 handler 软删该张已转存的图、中止该张及后续张的转存。
 */
export const moderateResult = async (params: {
  userId: number;
  generationId: number;
  image: { mime: string; base64: string };
  now?: Iso;
}): Promise<ModerationVerdict> => {
  const decision = await callModeration({ stage: 'result', image: params.image });
  recordModeration({
    userId: params.userId,
    stage: 'result',
    targetType: 'generation',
    targetId: params.generationId,
    decision,
    ...(params.now === undefined ? {} : { now: params.now }),
  });
  return decision.verdict;
};
