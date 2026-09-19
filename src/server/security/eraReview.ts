import { getArk, mapArkError } from '../ark';
import { AppError, appError } from '../domain/errors';
import { nowIso } from '../domain/time';
import type { EraCheck, EraCheckVerdict } from '../../shared/types';

/**
 * 年代穿帮复核 + 年龄偏差估计的**唯一入口**（`docs/prd/modules/M07-生成后复核与内容审核.md` §5.2、§5.4）。
 *
 * - **软标注**：复核判定（`eraCheckVerdict`）为 `review` / `reject` 不删图、不置任务失败（§5.3）；
 * - **复核 prompt 常量只在本文件持有**，handler 不得内联文本（§5.2、`spec/09-施工纪律.md` §4 D2）；
 * - `age_delta` 是**有符号**整数（负 = 变年轻），**不得取绝对值后上报**（§5.4）；
 * - 复核失败（超时 / 上游错误 / 无法解析）一律**抛错**，由 handler 决定"留 `NULL` + `warn` 继续"（§5.1 ③）。
 */

/** 复核 prompt 版本（`modules/M07` §5.2 的代码内常量；`EraCheck` 只有 4 键，版本不落库，见 §9 决策 5）。 */
export const ERA_CHECK_PROMPT_VERSION = 'era-check-v1';

/** `findings` 最多 5 条，超出按严重度截断（`modules/M07` §5.2 第 6 条）。 */
export const MAX_FINDINGS = 5;

/** 日志里附上游返回体时的截断长度。 */
const CONTENT_LOG_LIMIT = 500;

const log = (level: 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ level, scope: 'worker', job: 'eraReview', msg, ...extra, at: nowIso() });
  if (level === 'error') console.error(line);
  else console.warn(line);
};

/**
 * 复核 system prompt（`modules/M07` §5.2）：输入是生成图 + 所选年代口径（`eras.name` +
 * `eras.constraint_pack` 原文），只报告"所选年代之后才存在的物件"，不报告画质与相似度类问题。
 */
export const buildEraCheckPrompt = (input: { eraName: string; constraintPack: string }): string =>
  [
    `你在复核一张老照片风格的生成图是否符合所选年代：${input.eraName}。`,
    '所选年代的场景与主题口径如下（原文）：',
    input.constraintPack,
    '',
    '逐条照做：',
    '1. 只报告"所选年代之后才存在的物件"；更早的物件与跨年代中性的自然物（树木、天空、地面、水体）一律不报——这是复核的唯一定义。',
    '2. 画质类问题（颗粒、色调、曝光、对焦、构图、表情、服装是否好看）、人脸相似度、美化程度、AI 感都不报告。',
    '3. findings 每条的 item 是单一物件名（≤ 12 字，如「智能手机」），reason 一句话说明"画面何处 + 为什么晚于所选年代"（≤ 40 字）。',
    '4. 宁漏不误报：看不清、不确定的一律不报。',
    '5. verdict 口径写死：pass = 未发现晚于年代的物件；review = 1–2 个且位于非主体位置（远景、背景角落）；reject = 主体位置或 ≥ 3 处穿帮。',
    '6. findings 最多 5 条，超出按严重度截断；无发现时必须是空数组，不得输出占位项。',
    '7. 同时估计画面中人物年龄区间，键名 estimatedAgeRange（如 "70-78"），区间宽度 ≤ 8 岁；无法判断时给 null。',
    '',
    '严格输出 JSON，不要 Markdown 代码块与解释文字：',
    '{ "verdict": "pass | review | reject", "findings": [ { "item": "智能手机", "reason": "人物右手持黑色全面屏手机，1990 年代不存在该物件" } ], "estimatedAgeRange": "70-78" }',
  ].join('\n');

/** 剥 ```json 包裹（模型偶尔仍会包裹，`modules/M07` §5.2 的严格 JSON 要求）。 */
export const stripFence = (raw: string): string =>
  raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

/**
 * 区间字符串 → 中值（`modules/M07` §5.4）：`"75-85岁"` / `"70-78"` → 两端整数求平均并四舍五入；
 * 解析失败（少于两个整数，如 `"不详"` / `null`）返回 `null`。
 */
export const midOfRange = (range: string | null): number | null => {
  if (range === null) return null;
  const nums = range.match(/\d+/g);
  if (nums === null || nums.length < 2) return null;
  const low = Number(nums[0]);
  const high = Number(nums[1]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return Math.round((low + high) / 2);
};

/** 归一化后的 `findings`：条目必须带非空字符串 `item` 与 `reason`，超出 5 条截断，无发现即空数组。 */
const normalizeFindings = (value: unknown): Array<{ item: string; reason: string }> => {
  if (!Array.isArray(value)) return [];
  const out: Array<{ item: string; reason: string }> = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = (entry as Record<string, unknown>).item;
    const reason = (entry as Record<string, unknown>).reason;
    if (typeof item !== 'string' || item.trim() === '') continue;
    if (typeof reason !== 'string' || reason.trim() === '') continue;
    out.push({ item, reason });
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
};

export interface NormalizedEraCheck {
  /** 落库投影，只保留 `EraCheck` 的 4 个键（§5.2）。 */
  eraCheck: EraCheck;
  /** 消费后丢弃的年龄区间；`age_delta` 的唯一输入。 */
  estimatedAgeRange: string | null;
}

/**
 * 模型输出 → `EraCheck` 的归一（`modules/M07` §5.2）：`verdict` 非枚举值或缺失按 `findings` 推导
 * （空 → `pass`，非空 → `review`）；`verdict='pass'` 但 `findings` 非空提升为 `review`；
 * `findings` 超 5 条截断、非法条目丢弃；`passed = verdict === 'pass'`。
 * 正文无法解析为 JSON 对象 → 抛 `PROVIDER_ERROR`（§6 的 `INTERNAL` 一行按同一路径处理）。
 */
export const normalizeEraCheck = (raw: string, model: string | null): NormalizedEraCheck => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    throw appError('PROVIDER_ERROR', { reason: 'eraReview JSON.parse 失败' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw appError('PROVIDER_ERROR', { reason: 'eraReview 返回体不是 JSON 对象' });
  }
  const obj = parsed as Record<string, unknown>;
  const findings = normalizeFindings(obj.findings);

  const rawVerdict = obj.verdict;
  let verdict: EraCheckVerdict =
    rawVerdict === 'pass' || rawVerdict === 'review' || rawVerdict === 'reject'
      ? rawVerdict
      : findings.length === 0
        ? 'pass'
        : 'review';
  if (verdict === 'pass' && findings.length > 0) verdict = 'review';

  const estimated =
    typeof obj.estimatedAgeRange === 'string' && obj.estimatedAgeRange.trim() !== ''
      ? obj.estimatedAgeRange
      : null;

  return { eraCheck: { passed: verdict === 'pass', verdict, findings, model }, estimatedAgeRange: estimated };
};

export interface EraReviewParams {
  /** 生成图的 Base64 data URI。 */
  image: string;
  eraCode: string;
  sceneId: number;
  /** `eras.name`（复核输入中的"所选年代"）。 */
  eraName: string;
  /** `eras.constraint_pack` 原文（语义已含"必须属于该年代或更早"）。 */
  constraintPack: string;
  /** `identity_anchors.features_json.ageRange`；解析不了即 `age_delta = NULL`（§9 决策 4）。 */
  anchorAgeRange: string | null;
}

export interface EraReviewOutcome {
  eraCheck: EraCheck;
  ageDelta: number | null;
}

/**
 * 调上游复核并归一。**失败即抛错**（不在这里吞）：handler 捕获后留 `NULL` + `warn` 继续（§5.1 ③）。
 * `age_delta < 0`（变年轻）单独打一条 `warn`，附 `eraCode` / `sceneId`（§5.4 的定位要求）。
 */
export const eraReview = async (params: EraReviewParams): Promise<EraReviewOutcome> => {
  let raw: string;
  let model: string;
  try {
    const result = await getArk().reviewEra({
      systemPrompt: buildEraCheckPrompt({ eraName: params.eraName, constraintPack: params.constraintPack }),
      image: params.image,
      eraCode: params.eraCode,
      sceneId: params.sceneId,
      anchorAgeRange: params.anchorAgeRange,
    });
    raw = result.raw;
    model = result.model;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const mapped = mapArkError(err);
    throw appError(mapped.code, { reason: mapped.raw.slice(0, CONTENT_LOG_LIMIT) });
  }

  const { eraCheck, estimatedAgeRange } = normalizeEraCheck(raw, model);
  const anchorMid = midOfRange(params.anchorAgeRange);
  const estimatedMid = midOfRange(estimatedAgeRange);
  const ageDelta = anchorMid === null || estimatedMid === null ? null : estimatedMid - anchorMid;

  if (ageDelta !== null && ageDelta < 0) {
    log('warn', 'age_delta 为负（生成图比源照片年轻）', {
      eraCode: params.eraCode,
      sceneId: params.sceneId,
      ageDelta,
    });
  }
  return { eraCheck, ageDelta };
};
