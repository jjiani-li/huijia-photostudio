import type { AnchorFeatures } from '../../shared/types';
import { ArkUpstreamError } from './errors';
import type {
  AnchorExtractInput,
  AnchorExtractResult,
  ArkImageRequest,
  ArkImageResult,
  ArkProvider,
} from './types';

/**
 * `RealArkProvider`（`docs/prd/spec/08-本地开发指南.md` §5.2）：直连 HTTP + 模型名，
 * 不走 `/responses`、arkcli 或 Endpoint。仅在 `PROVIDER=real` 时使用，不纳入自动检查。
 */
const baseUrl = (): string => process.env.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3';
const visionModel = (): string => process.env.ARK_VISION_MODEL ?? 'doubao-seed-2-1-turbo-260628';
const imageModel = (): string => process.env.ARK_IMAGE_MODEL ?? 'doubao-seedream-5-0-lite-260128';
const timeoutMs = (): number => Number(process.env.ARK_TIMEOUT_SECONDS ?? 120) * 1000;

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}
interface ImageResponse {
  data?: Array<{ url?: string; size?: string; seed?: number }>;
  model?: string;
}

const postJson = async (pathname: string, body: unknown): Promise<unknown> => {
  const apiKey = process.env.ARK_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
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
      model: visionModel(),
      max_tokens: 1200,
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
    // reasoning_content 一律丢弃；只解析 content。
    const parsed = JSON.parse(content) as { anchorText?: string; features?: AnchorFeatures };
    if (typeof parsed.anchorText !== 'string' || parsed.features === undefined) {
      throw new ArkUpstreamError({ kind: 'http', errorCode: 'InvalidResponse', message: 'content 不是合法的锚点 JSON' });
    }
    return { anchorText: parsed.anchorText, features: parsed.features, model: visionModel() };
  }

  async generateImage(request: ArkImageRequest): Promise<ArkImageResult> {
    const body: Record<string, unknown> = {
      model: imageModel(),
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
    const data = (await postJson('/images/generations', body)) as ImageResponse;
    const images = (data.data ?? []).map((item) => ({
      url: item.url ?? '',
      size: item.size ?? null,
      // `seed` 仅在上游回传时记录，不作为复现依据（`spec/01` §3.10）。
      seed: typeof item.seed === 'number' ? item.seed : null,
    }));
    if (images.length === 0) {
      throw new ArkUpstreamError({ kind: 'http', errorCode: 'EmptyData', message: 'images/generations 未返回图片' });
    }
    return { images, model: data.model ?? imageModel() };
  }
}
