import { ArkUpstreamError } from './errors';
import type {
  AnchorExtractInput,
  AnchorExtractResult,
  ArkImageRequest,
  ArkImageResult,
  ArkProvider,
  EraReviewInput,
  EraReviewResult,
  PromptReverseInput,
  PromptReverseResult,
  SafetyReviewInput,
  SafetyReviewResult,
} from './types';

/**
 * `RealArkProvider`（`docs/prd/spec/08-本地开发指南.md` §5.2）：直连 HTTP + 模型名，
 * 不走 `/responses`、arkcli 或 Endpoint。仅在 `PROVIDER=real` 时使用，不纳入自动检查。
 */
const baseUrl = (): string => process.env.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3';
/** 读图模型名（`identity_anchors.model` 与 `chat/completions` 的 `model` 取同一份，避免第二份默认值）。 */
export const arkVisionModel = (): string =>
  process.env.ARK_VISION_MODEL ?? 'doubao-seed-2-1-turbo-260628';
/** 读图请求的 `max_tokens`（`docs/prd/modules/M03-身份锚点提取.md` §7 的代码内常量）。 */
export const ANCHOR_MAX_TOKENS = 1200;
/** 复核 / 审核请求的 `max_tokens`（`modules/M07-生成后复核与内容审核.md` §7 的代码内常量）。 */
export const REVIEW_MAX_TOKENS = 800;
/** 生图模型名（`generations.model` 与 `images/generations` 的 `model` 取同一份，避免第二份默认值）。 */
export const arkImageModel = (): string =>
  process.env.ARK_IMAGE_MODEL ?? 'doubao-seedream-5-0-lite-260128';
const timeoutMs = (): number => Number(process.env.ARK_TIMEOUT_SECONDS ?? 120) * 1000;

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}
interface ImageResponse {
  data?: Array<{ url?: string; size?: string; seed?: number }>;
  model?: string;
}

const postJson = async (pathname: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
  const apiKey = process.env.ARK_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new ArkUpstreamError({
      kind: aborted ? 'timeout' : 'network',
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const text = await response.text();
  if (!response.ok) {
    let errorCode: string | undefined;
    let message = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      errorCode = parsed.error?.code;
      message = parsed.error?.message ?? message;
    } catch {
      /* 保留原始文本片段 */
    }
    throw new ArkUpstreamError({ kind: 'http', httpStatus: response.status, errorCode, message });
  }
  return JSON.parse(text) as unknown;
};

export class RealArkProvider implements ArkProvider {
  async extractAnchor(input: AnchorExtractInput): Promise<AnchorExtractResult> {
    // messages 组装固定为「1 段 text → N 张 image_url」（`modules/M03-身份锚点提取.md` §5.4）。
    const data = (await postJson('/chat/completions', {
      model: arkVisionModel(),
      max_tokens: ANCHOR_MAX_TOKENS,
      messages: [
        { role: 'system', content: input.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请提取照片中人物的身份锚点特征。' },
            ...input.images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mime};base64,${img.base64}` },
            })),
          ],
        },
      ],
    })) as ChatResponse;

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ArkUpstreamError({ kind: 'http', errorCode: 'EmptyData', message: 'chat/completions 未返回 content' });
    }
    // reasoning_content 一律丢弃；正文原文原样返回，六步容错解析归 handler（`modules/M03` §5.3 步骤 4、§5.5）。
    return { raw: content, model: arkVisionModel() };
  }

  /**
   * F4 反推读图（`modules/M09-图片反推提示词.md` §5.1）：与 `extractAnchor` 同一条多模态通路，
   * `messages` 组装沿用 `modules/M03-身份锚点提取.md` §5.4（system 用字符串、user 的 text 在图片之前），
   * 本环节固定 1 张图。正文原文原样返回，五键解析与推荐值域归一归 handler。
   */
  async reversePrompt(input: PromptReverseInput): Promise<PromptReverseResult> {
    const data = (await postJson('/chat/completions', {
      model: arkVisionModel(),
      max_tokens: ANCHOR_MAX_TOKENS,
      messages: [
        { role: 'system', content: input.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请描述这张老照片的场景、光线、年代、服饰与构图，并给出推荐的年代与场景。' },
            ...input.images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mime};base64,${img.base64}` },
            })),
          ],
        },
      ],
    })) as ChatResponse;

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ArkUpstreamError({ kind: 'http', errorCode: 'EmptyData', message: 'chat/completions 未返回 content' });
    }
    // 与 extractAnchor 一致：`reasoning_content` 一律丢弃（turbo 默认开启 thinking）。
    return { raw: content, model: arkVisionModel() };
  }

  async generateImage(request: ArkImageRequest, signal?: AbortSignal): Promise<ArkImageResult> {
    const body: Record<string, unknown> = {
      model: arkImageModel(),
      prompt: request.prompt,
      image: request.images,
      size: request.size,
      response_format: 'url',
      watermark: request.watermark,
    };
    if (request.count > 1) {
      body.sequential_image_generation = 'auto';
      body.sequential_image_generation_options = { max_images: request.count };
    }
    const data = (await postJson('/images/generations', body, signal)) as ImageResponse;
    const images = (data.data ?? []).map((item) => ({
      url: item.url ?? '',
      size: item.size ?? null,
      // `seed` 仅在上游回传时记录，不作为复现依据（`spec/01` §3.10）。
      seed: typeof item.seed === 'number' ? item.seed : null,
    }));
    if (images.length === 0) {
      throw new ArkUpstreamError({ kind: 'http', errorCode: 'EmptyData', message: 'images/generations 未返回图片' });
    }
    return { images, model: data.model ?? arkImageModel() };
  }

  /**
   * `chat/completions` 的审核调用（`modules/M07` §5.6）：`upload` / `result` 送图，`prompt` 送文本。
   * 三段都应「对着真实内容」，因此不接受空输入（调用方保证 `image` / `text` 之一非空）。
   */
  async reviewSafety(input: SafetyReviewInput): Promise<SafetyReviewResult> {
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: input.text ?? '请判断这张图片是否包含违规内容。' },
    ];
    if (input.image !== null) content.push({ type: 'image_url', image_url: { url: input.image } });
    const data = (await postJson('/chat/completions', {
      model: arkVisionModel(),
      max_tokens: REVIEW_MAX_TOKENS,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content },
      ],
    })) as ChatResponse;
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new ArkUpstreamError({ kind: 'http', errorCode: 'EmptyData', message: 'chat/completions 未返回 content' });
    }
    return { raw: text, model: arkVisionModel() };
  }

  /** 年代穿帮复核调用（`modules/M07` §5.2）：`messages` 组装与读图一致，正文原文原样返回。 */
  async reviewEra(input: EraReviewInput): Promise<EraReviewResult> {
    const data = (await postJson('/chat/completions', {
      model: arkVisionModel(),
      max_tokens: REVIEW_MAX_TOKENS,
      messages: [
        { role: 'system', content: input.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请按系统提示复核这张生成图。' },
            { type: 'image_url', image_url: { url: input.image } },
          ],
        },
      ],
    })) as ChatResponse;
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new ArkUpstreamError({ kind: 'http', errorCode: 'EmptyData', message: 'chat/completions 未返回 content' });
    }
    return { raw: text, model: arkVisionModel() };
  }
}
