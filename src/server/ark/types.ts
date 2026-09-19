/**
 * `ArkProvider` 抽象与 DTO（`docs/prd/modules/M03-身份锚点提取.md` §5.4、
 * `modules/M06-生成编排.md` §5.8–§5.9）。业务代码只依赖本接口，**不得直接 `fetch`**。
 */
export interface ArkImageInput {
  /** `photos.mime` 的落库值（不用扩展名推断）。 */
  mime: string;
  base64: string;
}

export interface AnchorExtractInput {
  /** 参与提取的图（1–5 张，顺序等于 `input_photo_ids`）。 */
  images: ArkImageInput[];
  /** 提取用的 system prompt 全文（`modules/M03` 的 `ANCHOR_PROMPT_VERSION` 对应版本）。 */
  systemPrompt: string;
}

export interface AnchorExtractResult {
  /**
   * 上游助手正文原文（`choices[0].message.content`），**未解析**。
   * 容错解析（剥包裹 / JSON.parse / 12 键 / 长度 / 词表）一律由
   * `jobs/handlers/anchorExtract.ts` 的 `parseAnchorResponse` 按 `modules/M03` §5.5 执行，
   * provider 只负责取回正文、不做校验（`modules/M03-身份锚点提取.md` §5.3 步骤 4）。
   */
  raw: string;
  model: string;
}

export interface PromptReverseInput {
  /** 反推读图的图（本环节固定 1 张）。 */
  images: ArkImageInput[];
  /** 反推用的 system prompt 全文（`src/server/prompt/versions.ts` 的 `REVERSE_V1_SYSTEM_PROMPT`）。 */
  systemPrompt: string;
}

export interface PromptReverseResult {
  /**
   * 上游助手正文原文（`choices[0].message.content`），**未解析**；`reasoning_content` 一律丢弃。
   * 容错解析（剥包裹 / JSON.parse / 五键 / 推荐值域 / 词表）由 `jobs/handlers/reversePrompt.ts`
   * 的 `parseReverseResponse` 按 `modules/M09-图片反推提示词.md` §5.4 执行。
   */
  raw: string;
  model: string;
}

export interface ArkImageRequest {
  prompt: string;
  /** Base64 data URI 参考图。 */
  images: string[];
  size: string;
  outputFormat: 'png' | 'jpeg';
  watermark: boolean;
  /** 2–4；>1 时上游走 `sequential_image_generation`。 */
  count: number;
}

export interface ArkImageResultItem {
  /** 上游签名 URL（86400s 有效）；mock 下指向 `fixtures/images/`。 */
  url: string;
  size: string | null;
  seed: number | null;
}

export interface ArkImageResult {
  images: ArkImageResultItem[];
  model: string;
}

export interface SafetyReviewInput {
  /** 审核阶段（`docs/prd/modules/M07-生成后复核与内容审核.md` §5.6）；mock 依它选 variant。 */
  stage: 'upload' | 'prompt' | 'result';
  /** 审核用 system prompt 全文（`security/moderation.ts` 持有版本常量）。 */
  systemPrompt: string;
  /** `upload` / `result` 阶段的待审图片（Base64 data URI）；`prompt` 阶段为 `null`。 */
  image: string | null;
  /** `prompt` 阶段的待审文本；图像阶段为 `null`。 */
  text: string | null;
}

export interface SafetyReviewResult {
  /**
   * 上游助手正文原文（`choices[0].message.content`），**未解析**。
   * 判定归一（剥包裹 / JSON.parse / 枚举校验）由 `security/moderation.ts` 负责，provider 不做校验。
   */
  raw: string;
  model: string;
}

export interface EraReviewInput {
  /** 复核用 system prompt 全文（含所选年代口径，`security/eraReview.ts` 持有）。 */
  systemPrompt: string;
  /** 生成图 Base64 data URI。 */
  image: string;
  /**
   * fixture 选择用（`fixtures/ark/era-check.json` 的 `match` 按 `eraCode` + `sceneId` 命中）；
   * `real` 侧不使用，年代口径已进 `systemPrompt`。
   */
  eraCode: string;
  sceneId: number;
  /** 锚点 `features.ageRange`：样本 `estimatedAgeRange` 为 `null` 时回填（mock）。 */
  anchorAgeRange: string | null;
}

export interface EraReviewResult {
  /** 上游助手正文原文，**未解析**；归一（verdict 收敛 / 四键投影）由 `security/eraReview.ts` 负责。 */
  raw: string;
  model: string;
}

export interface ArkProvider {
  /** F1 读图：一次调用返回 `anchorText` + 12 键 `features`。 */
  extractAnchor(input: AnchorExtractInput): Promise<AnchorExtractResult>;
  /** F4 反推读图（`modules/M09` §5.1）：返回正文原文，五键解析与推荐值域归一归 `jobs/handlers/reversePrompt.ts`。 */
  reversePrompt(input: PromptReverseInput): Promise<PromptReverseResult>;
  /** 三阶段内容安全审核（`modules/M07` §5.6）；返回正文原文，判定与落库归 `security/moderation.ts`。 */
  reviewSafety(input: SafetyReviewInput): Promise<SafetyReviewResult>;
  /** 年代穿帮复核 + 年龄估计（`modules/M07` §5.2）；返回正文原文，归一归 `security/eraReview.ts`。 */
  reviewEra(input: EraReviewInput): Promise<EraReviewResult>;
  /**
   * F2 生图：返回 `count` 张候选（每张需立即转存，签名链会过期）。
   * `signal` 由 worker 的 `JOB_TIMEOUT_SECONDS` 竞速注入，用于中止仍在飞的上游调用
   * （`spec/04-技术基线与目录结构.md` §4.6；中止按超时映射为 `PROVIDER_TIMEOUT`）。
   */
  generateImage(request: ArkImageRequest, signal?: AbortSignal): Promise<ArkImageResult>;
}
