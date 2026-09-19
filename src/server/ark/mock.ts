import type { AnchorFeatures } from '../../shared/types';
import { ArkUpstreamError } from './errors';
import { readFailureFixture, readFixture, type MockFailureId } from './fixtures';
import type {
  AnchorExtractInput,
  AnchorExtractResult,
  ArkImageRequest,
  ArkImageResult,
  ArkProvider,
} from './types';

/**
 * `MockArkProvider`（`docs/prd/spec/08-本地开发指南.md` §5.1）：fixture 回放、确定性、
 * 每次调用 300–800ms sleep 模拟异步。
 */
interface AnchorExtractFixture {
  promptVersion: string;
  model: string;
  anchorText: string;
  features: AnchorFeatures;
}
interface ImageGenerationFixture {
  model: string;
  data: Array<{ url: string; size: string | null }>;
}

const IMAGE_FIXTURE_COUNT = 3;
const AGE_MIN = 40;
const AGE_SPAN = 45; // 40–84
const SLEEP_BASE_MS = 300;
const SLEEP_SPAN_MS = 500; // 300–800
/** prompt 里带这个标记即回放「fixtures 中不存在的场景」分支（接口不含 era/scene，见本工单 Comments）。 */
export const MOCK_UNKNOWN_SCENE_MARKER = '__MOCK_UNKNOWN_SCENE__';

/** djb2-ish 稳定哈希（同一输入永远同一输出）。 */
const hash = (text: string): number => {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h >>> 0;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class MockArkProvider implements ArkProvider {
  private failure: MockFailureId | null = null;

  /** 用例显式指定回放目标后，失败分支才生效（`spec/08` §5.1）。 */
  setFailure(id: MockFailureId | null): void {
    this.failure = id;
  }

  async extractAnchor(input: AnchorExtractInput): Promise<AnchorExtractResult> {
    const seed = hash(input.images.map((img) => img.base64).join('|'));
    await delay(SLEEP_BASE_MS + (seed % SLEEP_SPAN_MS));

    const fixture = readFixture<AnchorExtractFixture>('ark/anchor-extract.json');
    // 年龄按输入稳定替换（同一输入永远同一输出，保证测试可重复）。
    const age = AGE_MIN + (seed % AGE_SPAN);
    const features: AnchorFeatures = { ...fixture.features, ageRange: `${age - 4}-${age + 4}` };
    const anchorText = fixture.anchorText.replace(/\d+\s*岁/, `${age} 岁`);
    // DTO 只回正文原文（`AnchorExtractResult.raw`）：容错解析与 12 键校验归 handler（`modules/M03` §5.5）。
    return { raw: JSON.stringify({ anchor: anchorText, features }), model: fixture.model };
  }

  async generateImage(request: ArkImageRequest, signal?: AbortSignal): Promise<ArkImageResult> {
    await delay(SLEEP_BASE_MS + (hash(request.prompt) % SLEEP_SPAN_MS));
    // worker 的 `JOB_TIMEOUT_SECONDS` 中止（`spec/04` §4.6）：按超时映射为 `PROVIDER_TIMEOUT`。
    if (signal?.aborted === true) {
      throw new ArkUpstreamError({ kind: 'timeout', message: 'job aborted' });
    }

    if (this.failure !== null) throw new ArkUpstreamError(readFailureFixture(this.failure));
    if (request.prompt.includes(MOCK_UNKNOWN_SCENE_MARKER)) {
      throw new ArkUpstreamError({ kind: 'http', httpStatus: 400, message: 'fixtures 中不存在该场景' });
    }

    const fixture = readFixture<ImageGenerationFixture>('ark/image-generation.json');
    const images = Array.from({ length: request.count }, (_, ordinal) => {
      // `(hash(prompt) + ordinal) % 3`：`count ≥ 2` 时前两张必然落在不同的 fixture 上
      // （`E2E-07` 要求至少 2 张 sha256 不同），同一 prompt 仍确定性回放。
      const index = (hash(request.prompt) + ordinal) % IMAGE_FIXTURE_COUNT;
      const picked = fixture.data[index] ?? fixture.data[0];
      return {
        url: picked?.url ?? 'fixtures/images/generated-01.png',
        size: picked?.size ?? null,
        seed: null,
      };
    });
    return { images, model: fixture.model };
  }
}
