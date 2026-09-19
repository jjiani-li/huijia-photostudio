import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, apiRequest, toErrorNotice } from './api-client';

/** 唯一请求入口（`docs/prd/pages/P00-设计基准与路由.md` §1、§2）：`same-origin` + error envelope → `ApiClientError`。 */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('成功 → 直接返回业务对象（`credentials: same-origin`）', async () => {
    const fetchMock = vi.fn(async () => json({ photo: { id: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/api/x')).resolves.toEqual({ photo: { id: 1 } });
    expect(fetchMock).toHaveBeenCalledWith('/api/x', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('错误 envelope → ApiClientError（code / message / status / details）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ error: { code: 'QUOTA_EXCEEDED', message: '今天的生成额度用完了', details: { a: 1 } } }, 429),
      ),
    );

    await expect(apiRequest('/api/x')).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      message: '今天的生成额度用完了',
      status: 429,
      details: { a: 1 },
    });
  });

  it('POST JSON 时带 Content-Type 与序列化后的 body', async () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/api/x', { method: 'POST', body: { a: 1 } });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/x',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: '{"a":1}',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('formData 时不设 Content-Type（交给浏览器带 boundary）', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => json({ photo: { id: 1 } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/api/photos', { method: 'POST', formData: new FormData() });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
  });
});

describe('toErrorNotice', () => {
  it('ApiClientError → 原样；其他异常 → INTERNAL + 兜底文案（不透技术串）', () => {
    expect(toErrorNotice(new ApiClientError('CODE_INVALID', '验证码不对', 400))).toEqual({
      code: 'CODE_INVALID',
      message: '验证码不对',
    });
    expect(toErrorNotice(new Error('Failed to fetch'))).toEqual({
      code: 'INTERNAL',
      message: '出了点小问题，请重试',
    });
  });

  it('服务端 message 为空的边界 → 取错误码的兜底文案', () => {
    expect(toErrorNotice(new ApiClientError('STORAGE_ERROR', '   ', 500))).toEqual({
      code: 'STORAGE_ERROR',
      message: '保存失败，请重试',
    });
  });
});
