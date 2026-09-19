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

export interface ArkProvider {
  /** F1 读图：一次调用返回 `anchorText` + 12 键 `features`。 */
  extractAnchor(input: AnchorExtractInput): Promise<AnchorExtractResult>;
  /** F2 生图：返回 `count` 张候选（每张需立即转存，签名链会过期）。 */
  generateImage(request: ArkImageRequest): Promise<ArkImageResult>;
}
