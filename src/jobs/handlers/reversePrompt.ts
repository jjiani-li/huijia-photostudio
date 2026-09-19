import { z } from 'zod';
import { getArk, mapArkError } from '../../server/ark';
import { AppError, ERROR_MESSAGE, appError } from '../../server/domain/errors';
import { nowIso } from '../../server/domain/time';
import { getEra, getScene } from '../../server/db/repositories/config';
import { findActivePhotoForUser } from '../../server/db/repositories/photos';
import {
  claimForRun,
  findById,
  markSucceeded,
} from '../../server/db/repositories/promptReverseJobs';
import { REVERSE_V1_SYSTEM_PROMPT } from '../../server/prompt/versions';
import { getStorage } from '../../server/storage';
import {
  promptReverseDetailSchema,
  type ErrorCode,
  type PromptReverseDetail,
} from '../../shared/types';
import { AUTO_RETRY_ERROR_CODES, settleJobFailure } from '../settle';
import { stripFence } from './anchorExtract';

/**
 * `prompt_reverse_jobs` 的读图 handler（`docs/prd/modules/M09-图片反推提示词.md` §5）。
 * 契约：`claim → 读图 → 调上游 → 容错解析 → 写终态`；**任何异常都在本文件内落终态**，
 * 绝不把 `AppError` 抛给 worker 主循环（`docs/prd/spec/04-技术基线与目录结构.md` §4.6）。
 *
 * 与 `modules/M03-身份锚点提取.md` 的差异只有两处：结果落 `prompt_reverse_jobs`（不碰
 * `identity_anchors`），且**推荐值越界只置 `null`、不判失败**（§5.4 的弱约束）。
 */

/** 日志里附上游返回体时的截断长度（同 `modules/M03-身份锚点提取.md` §5.3 步骤 5）。 */
const CONTENT_LOG_LIMIT = 500;

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ level, scope: 'worker', job: 'reversePrompt', msg, ...extra, at: nowIso() });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/**
 * §5.4 第 4 步的三类词表（`docs/prd/spec/05-Prompt工程.md` §4 的黑名单语义）：
 * 减龄、美化、换脸。命中任一即落 `PROVIDER_ERROR`——这类描述会让后续重建把人物理想化。
 */
const ANTI_AGE_RE = /磨皮|祛皱|除皱|去皱|去斑|去老年斑|年轻化|显年轻|显得年轻|减龄|变年轻/i;
const BEAUTIFY_RE = /慈祥|有气质|精神矍铄|面容温和|和蔼|儒雅|端庄|保养得好/i;
const FACE_SWAP_RE = /换脸|换人|替换面孔|改变性别|改变年龄/i;

/** 五键 + `result_prompt` 的结构校验：六个值都必须是非空字符串（多余键被 `.strip()` 丢弃）。 */
const reverseResponseSchema = promptReverseDetailSchema.extend({
  result_prompt: z.string().min(1),
});

/** 推荐值的取值域（`eras.code` / `scenes.id`）——由调用方注入，解析函数本身保持纯函数。 */
export interface ReverseDomain {
  eraCodeAllowed(code: string): boolean;
  sceneIdAllowed(id: number): boolean;
}

/** handler 用的取值域：唯一事实源是两张配置表（不把 `E1`–`E4` 再抄一份到代码里）。 */
export const configReverseDomain: ReverseDomain = {
  eraCodeAllowed: (code) => getEra(code) !== null,
  sceneIdAllowed: (id) => getScene(id) !== null,
};

export type ReverseParse =
  | {
      ok: true;
      result: PromptReverseDetail;
      resultPrompt: string;
      suggestEraCode: string | null;
      suggestSceneId: number | null;
    }
  | { ok: false; reason: string };

/**
 * §5.4 的容错解析，**按 `modules/M03-身份锚点提取.md` §5.5 的同一顺序执行、任一步失败都返回失败**
 * （调用方一律落 `PROVIDER_ERROR`）：
 * ① 剥包裹 → ② 反序列化 → ③ 五键 + `result_prompt` 非空 → ④ 推荐值域越界置 `null`（**不判失败**）
 * → ⑤ 减龄 / 美化 / 换脸词表拦截。
 */
export const parseReverseResponse = (raw: string, domain: ReverseDomain): ReverseParse => {
  // ① 剥包裹
  const text = stripFence(raw);

  // ② 反序列化：必须是对象
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'JSON.parse 失败' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: '返回体不是 JSON 对象' };
  }

  // ③ 结构校验：五键与 result_prompt 缺一不可、均为非空字符串
  const schema = reverseResponseSchema.safeParse(parsed);
  if (!schema.success) {
    return {
      ok: false,
      reason: `结构校验失败：${schema.error.issues.map((i) => i.path.join('.')).join(',')}`,
    };
  }
  const { result_prompt: resultPrompt, ...result } = schema.data;

  // ④ 推荐值域：越界 / 类型不符 / 缺键一律置 null，不判失败（§5.4「推荐是弱约束」）
  const rawEra = (parsed as Record<string, unknown>).suggest_era_code;
  const rawScene = (parsed as Record<string, unknown>).suggest_scene_id;
  const suggestEraCode =
    typeof rawEra === 'string' && domain.eraCodeAllowed(rawEra) ? rawEra : null;
  const suggestSceneId =
    typeof rawScene === 'number' && Number.isInteger(rawScene) && domain.sceneIdAllowed(rawScene)
      ? rawScene
      : null;

  // ⑤ 词表拦截：五个描述字段 + 自然语言提示词，任一命中即失败
  const fields = [...Object.values(result), resultPrompt];
  for (const [re, reason] of [
    [ANTI_AGE_RE, '命中减龄词表'],
    [BEAUTIFY_RE, '命中美化词表'],
    [FACE_SWAP_RE, '命中换脸词表'],
  ] as const) {
    if (fields.some((value) => re.test(value))) return { ok: false, reason };
  }

  return { ok: true, result, resultPrompt, suggestEraCode, suggestSceneId };
};

/** 失败处置用的三元组：错误码、是否瞬时错误、上游原文（只进日志，**不进 `error_message`**）。 */
export interface ReverseFailure {
  code: ErrorCode;
  retryable: boolean;
  raw: string;
}

const toFailure = (err: unknown): ReverseFailure => {
  if (err instanceof AppError) {
    return { code: err.code, retryable: AUTO_RETRY_ERROR_CODES.has(err.code), raw: err.message };
  }
  const mapped = mapArkError(err);
  return { code: mapped.code, retryable: mapped.retryable, raw: mapped.raw };
};

/**
 * 失败落库（`docs/prd/spec/04-技术基线与目录结构.md` §4.6）：走 `src/jobs/settle.ts` 的唯一入口
 * `settleJobFailure`——本次零产出、错误码属瞬时集合、`attempt < 1` 且该错误在
 * `modules/M06-生成编排.md` §5.8 的「可重试」列也标可重试 → 置回 `queued` 并 `attempt + 1`；
 * 否则落终态 `failed`。
 *
 * `error_message` 传用户可见文案：`modules/M09-图片反推提示词.md` §5.4 要求模型原文只进
 * `logger.warn`、**不进 `error_message`**（避免把上游原文透给用户）。
 */
const fail = (record: { id: number; attempt: number }, failure: ReverseFailure): void => {
  try {
    const outcome = settleJobFailure({
      table: 'prompt_reverse_jobs',
      id: record.id,
      attempt: record.attempt,
      produced: 0,
      code: failure.code,
      rawMessage: ERROR_MESSAGE[failure.code],
      retryable: failure.retryable,
    });
    log('warn', 'settled', { jobId: record.id, code: failure.code, outcome });
  } catch (err) {
    // 落库失败也只记日志，绝不抛出（worker 主循环必须活着）。
    log('error', 'settle 落库失败', { jobId: record.id, code: failure.code, error: String(err) });
  }
};

/**
 * `JOB_TIMEOUT_SECONDS` 兜底（`spec/04` §4.6）：worker 到点 abort 后由 `registry` 调用。
 * **只对仍处 `running` 的行生效**——handler 可能已自行落终态，无条件重写会覆盖结果。
 */
export const failTimedOutReverseJob = (id: number): void => {
  const record = findById(id);
  if (record === null || record.status !== 'running') return;
  const startedAtMs = Date.now();
  fail(record, { code: 'PROVIDER_TIMEOUT', retryable: true, raw: 'job timed out' });
  log('info', 'timeout settled', { jobId: id, attempt: record.attempt, ms: Date.now() - startedAtMs });
};

export interface ReversePromptJob {
  jobId: number;
}

/**
 * worker handler 入口（§5.1、§5.4）。`claim` 失败即返回；其余任何分支都写 `prompt_reverse_jobs` 的终态。
 * 本环节固定 1 张图（`modules/M09` §5.1），只取 `choices[0].message.content`（由 provider 保证）。
 */
export const reversePromptHandler = async (job: ReversePromptJob): Promise<void> => {
  const startedAtMs = Date.now();
  const record = findById(job.jobId);
  if (record === null) {
    log('warn', 'job not found', { jobId: job.jobId });
    return;
  }

  // ① claim：仅 `queued → running` 成功（`changes === 1`）才继续，否则直接放弃本轮（§4.6）。
  if (claimForRun(record.id, nowIso()) !== 1) {
    log('info', 'claim skipped', { jobId: record.id, status: record.status });
    return;
  }

  try {
    // ② 读源照片：入队时已校验，此处读不到是「入队后被删」的竞态，属我方数据问题（同 `M03` §5.3）。
    const photo = findActivePhotoForUser(record.sourcePhotoId, record.userId);
    if (photo === null) {
      throw appError('INTERNAL', { reason: `源照片 ${record.sourcePhotoId} 不存在或已软删` });
    }
    const buffer = await getStorage().read(photo.storageKey);

    // ③ 调读图 + §5.4 容错解析。provider 只回正文原文，解析全在本处。
    const result = await getArk().reversePrompt({
      images: [{ mime: photo.mime, base64: buffer.toString('base64') }],
      systemPrompt: REVERSE_V1_SYSTEM_PROMPT,
    });
    const parsed = parseReverseResponse(result.raw, configReverseDomain);
    if (!parsed.ok) {
      log('warn', '反推解析不合格', {
        jobId: record.id,
        reason: parsed.reason,
        // 模型原文只进日志（§5.4）：不进 `error_message`，避免把上游原文透给用户。
        content: result.raw.slice(0, CONTENT_LOG_LIMIT),
      });
      fail(record, { code: 'PROVIDER_ERROR', retryable: true, raw: parsed.reason });
      return;
    }

    // ④ 成功落库：`result_json`（五键）/ `result_prompt` 非空，推荐值可空。
    const changes = markSucceeded({
      id: record.id,
      result: parsed.result,
      resultPrompt: parsed.resultPrompt,
      suggestEraCode: parsed.suggestEraCode,
      suggestSceneId: parsed.suggestSceneId,
      finishedAt: nowIso(),
    });
    // `changes === 0`：该行已被判定为终态（`JOB_TIMEOUT_SECONDS` 兜底先落库），不覆盖别人的终态。
    if (changes === 0) {
      log('warn', 'succeeded 落库被跳过（行已非 running）', { jobId: record.id, ms: Date.now() - startedAtMs });
      return;
    }
    log('info', 'done', {
      jobId: record.id,
      suggestEraCode: parsed.suggestEraCode,
      suggestSceneId: parsed.suggestSceneId,
      ms: Date.now() - startedAtMs,
    });
  } catch (err) {
    const failure = toFailure(err);
    log('warn', 'reverse prompt failed', {
      jobId: record.id,
      code: failure.code,
      reason: failure.raw.slice(0, CONTENT_LOG_LIMIT),
      ms: Date.now() - startedAtMs,
    });
    fail(record, failure);
  }
};
