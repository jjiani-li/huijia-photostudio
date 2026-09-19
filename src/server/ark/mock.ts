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
  version: string;
  model: string;
  anchorText: string | null;
  features: AnchorFeatures | null;
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
    if (fixture.anchorText === null || fixture.features === null) {
      throw new ArkUpstreamError({ kind: 'http', httpStatus: 422, message: 'fixture 样本无人脸' });
    }
    // 年龄按输入稳定替换（同一输入永远同一输出，保证测试可重复）。
    const age = AGE_MIN + (seed % AGE_SPAN);
    const features: AnchorFeatures = { ...fixture.features, ageRange: `${age - 4}-${age + 4}` };
    const anchorText = fixture.anchorText.replace(/\d+岁/, `${age}岁`);
    return { anchorText, features, model: fixture.model };
  }

  async generateImage(request: ArkImageRequest): Promise<ArkImageResult> {
    await delay(SLEEP_BASE_MS + (hash(request.prompt) % SLEEP_SPAN_MS));

    if (this.failure !== null) throw new ArkUpstreamError(readFailureFixture(this.failure));
    if (request.prompt.includes(MOCK_UNKNOWN_SCENE_MARKER)) {
      throw new ArkUpstreamError({ kind: 'http', httpStatus: 400, message: 'fixtures 中不存在该场景' });
    }

    const fixture = readFixture<ImageGenerationFixture>('ark/image-generation.json');
    const images = Array.from({ length: request.count }, (_, ordinal) => {
      const index = hash(`${request.prompt}|${ordinal}`) % IMAGE_FIXTURE_COUNT;
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
