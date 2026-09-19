import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEraSceneConfig, resetEraSceneConfigCache } from './use-era-scene-config';

/**
 * `useEraSceneConfig` 的模块级缓存（`docs/prd/pages/P00-设计基准与路由.md` §10、§12）：
 * 标签页内只发一次请求（`API-06`）。
 */
const CONFIG = {
  version: 'seed-v1',
  confidenceHintThreshold: 0.6,
  realismAnchor: 'x',
  eras: [],
  scenes: [],
  profiles: [],
};

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  resetEraSceneConfigCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('loadEraSceneConfig', () => {
  it('两次调用只发 1 次请求，且 `credentials: same-origin`', async () => {
    const fetchMock = vi.fn(async () => okResponse(CONFIG));
    vi.stubGlobal('fetch', fetchMock);

    const first = await loadEraSceneConfig();
    const second = await loadEraSceneConfig();

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/config/era-scene',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('并发调用共享同一请求（in-flight 去重）', async () => {
    const fetchMock = vi.fn(async () => okResponse(CONFIG));
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([loadEraSceneConfig(), loadEraSceneConfig()]);

    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
