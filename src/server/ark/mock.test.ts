import { describe, expect, it } from 'vitest';
import { ArkUpstreamError, mapArkError } from './errors';
import { MOCK_UNKNOWN_SCENE_MARKER, MockArkProvider } from './mock';
import type { ArkImageRequest } from './types';

/**
 * `MockArkProvider` 的确定性回放（`docs/prd/spec/08-本地开发指南.md` §5.1）。
 * 每次调用有 300–800ms sleep，故用例比纯函数慢。
 */
const request = (over: Partial<ArkImageRequest> = {}): ArkImageRequest => ({
  prompt: '【年代】E2 【场景】S1',
  images: [],
  size: '2048x2048',
  outputFormat: 'png',
  watermark: false,
  count: 3,
  ...over,
});

describe('MockArkProvider.extractAnchor', () => {
  const parsed = (r: { raw: string }): { anchor: string; features: Record<string, string> } =>
    JSON.parse(r.raw) as { anchor: string; features: Record<string, string> };

  it('同一输入稳定（年龄按输入替换、features 恰 12 键）', async () => {
    const provider = new MockArkProvider();
    const input = { images: [{ mime: 'image/jpeg', base64: 'AAA' }], systemPrompt: 'sys' };
    const first = parsed(await provider.extractAnchor(input));
    const second = parsed(await provider.extractAnchor(input));
    expect(first.anchor).toBe(second.anchor);
    expect(first.features.ageRange).toBe(second.features.ageRange);
    expect(Object.keys(first.features)).toHaveLength(12);
  });

  it('不同输入得到不同年龄（伪随机、非固定）', async () => {
    const provider = new MockArkProvider();
    const a = parsed(await provider.extractAnchor({ images: [{ mime: 'image/jpeg', base64: 'AAA' }], systemPrompt: 's' }));
    const b = parsed(await provider.extractAnchor({ images: [{ mime: 'image/jpeg', base64: 'BBB' }], systemPrompt: 's' }));
    expect(a.features.ageRange).not.toBe(b.features.ageRange);
  });
});

describe('MockArkProvider.generateImage', () => {
  it('返回 count 张、确定性选图（同 prompt 同 ordinal 同 url）', async () => {
    const provider = new MockArkProvider();
    const first = await provider.generateImage(request());
    expect(first.images).toHaveLength(3);
    const second = await provider.generateImage(request());
    expect(second.images.map((i) => i.url)).toEqual(first.images.map((i) => i.url));
  });

  it('setFailure 指定的失败分支按 mapArkError 映射', async () => {
    const provider = new MockArkProvider();
    provider.setFailure('timeout');
    const err = await provider.generateImage(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArkUpstreamError);
    expect(mapArkError(err).code).toBe('PROVIDER_TIMEOUT');
    expect(mapArkError(err).retryable).toBe(true);
    provider.setFailure(null);
  });

  it('未知场景标记 → PROVIDER_ERROR', async () => {
    const provider = new MockArkProvider();
    const err = await provider.generateImage(request({ prompt: MOCK_UNKNOWN_SCENE_MARKER })).catch((e: unknown) => e);
    expect(mapArkError(err).code).toBe('PROVIDER_ERROR');
  });
});

/**
 * 复核 / 审核回放（`docs/prd/modules/M07-生成后复核与内容审核.md` §7.1–§7.2）。
 * **只读 fixture**：开关（`switch.activeCaseId` / `switchVariants[stage]`）的写入与还原由
 * `scripts/acceptance.ts` 负责，vitest 侧不走开关，避免并发写同一份夹具文件。
 */
describe('MockArkProvider.reviewSafety', () => {
  it('默认 variant 为 pass，返回未解析的正文 + 模型名', async () => {
    const provider = new MockArkProvider();
    const result = await provider.reviewSafety({
      stage: 'upload',
      systemPrompt: 'sys',
      image: 'data:image/png;base64,AAAA',
      text: null,
    });
    expect(JSON.parse(result.raw)).toEqual({ verdict: 'pass', reason: null });
    expect(result.model).toBe('doubao-seed-2-1-turbo-260628');
  });
});

describe('MockArkProvider.reviewEra', () => {
  const input = (over: Partial<{ eraCode: string; sceneId: number; anchorAgeRange: string | null }> = {}) => ({
    systemPrompt: 'sys',
    image: 'data:image/png;base64,AAAA',
    eraCode: 'E4',
    sceneId: 9,
    anchorAgeRange: '70-80岁',
    ...over,
  });

  it('默认 clean 样本：verdict=pass、findings 为空，estimatedAgeRange 用 anchorAgeRange 回填', async () => {
    const result = JSON.parse(await new MockArkProvider().reviewEra(input()).then((r) => r.raw)) as {
      verdict: string;
      findings: unknown[];
      estimatedAgeRange: string | null;
    };
    expect(result.verdict).toBe('pass');
    expect(result.findings).toEqual([]);
    expect(result.estimatedAgeRange).toBe('70-80岁');
  });

  it('match 命中：E2×S3 → review 样本，estimatedAgeRange 取样本值', async () => {
    const result = JSON.parse(
      await new MockArkProvider().reviewEra(input({ eraCode: 'E2', sceneId: 3 })).then((r) => r.raw),
    ) as { verdict: string; estimatedAgeRange: string | null };
    expect(result.verdict).toBe('review');
    expect(result.estimatedAgeRange).toBe('66-74');
  });

  it('同一输入两次回放结果一致（确定性）', async () => {
    const provider = new MockArkProvider();
    const first = await provider.reviewEra(input({ eraCode: 'E2', sceneId: 3 }));
    const second = await provider.reviewEra(input({ eraCode: 'E2', sceneId: 3 }));
    expect(second.raw).toBe(first.raw);
  });
});
