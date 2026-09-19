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
  it('同一输入稳定（年龄按输入替换、features 恰 12 键）', async () => {
    const provider = new MockArkProvider();
    const input = { images: [{ mime: 'image/jpeg', base64: 'AAA' }], systemPrompt: 'sys' };
    const first = await provider.extractAnchor(input);
    const second = await provider.extractAnchor(input);
    expect(first.anchorText).toBe(second.anchorText);
    expect(first.features.ageRange).toBe(second.features.ageRange);
    expect(Object.keys(first.features)).toHaveLength(12);
  });

  it('不同输入得到不同年龄（伪随机、非固定）', async () => {
    const provider = new MockArkProvider();
    const a = await provider.extractAnchor({ images: [{ mime: 'image/jpeg', base64: 'AAA' }], systemPrompt: 's' });
    const b = await provider.extractAnchor({ images: [{ mime: 'image/jpeg', base64: 'BBB' }], systemPrompt: 's' });
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
