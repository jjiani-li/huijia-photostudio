import { afterEach, describe, expect, it, vi } from 'vitest';
import { meLoaderFor } from './site-header';

/**
 * 额度刷新的机制（`docs/prd/pages/P00-设计基准与路由.md` §10：`POST /api/generations` 预扣后
 * 重拉 `GET /api/me` 刷新 `SiteHeader` 额度）。布局在站内跳转时不重挂载，所以 `useApiRequest`
 * 必须在**路径变化**时换到新的 loader 引用才会重取：同一路径稳定、换路径换引用。
 */
describe('meLoaderFor', () => {
  it('同一路径返回同一个引用（同一页重复渲染不重取）', () => {
    expect(meLoaderFor('/choose/1')).toBe(meLoaderFor('/choose/1'));
  });

  it('换路径返回新引用（提交后跳到 /result/:id 会重取一次）', () => {
    const onChoose = meLoaderFor('/choose/1');
    const onResult = meLoaderFor('/result/9');
    expect(onResult).not.toBe(onChoose);
  });

  it('loader 发起的是 `GET /api/me`（`credentials: same-origin`）', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ user: { id: 1 }, quota: { remaining: 9 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const me = await meLoaderFor('/choose/3')();
    expect(me).toEqual({ user: { id: 1 }, quota: { remaining: 9 } });
    expect(fetchMock).toHaveBeenCalledWith('/api/me', expect.objectContaining({ credentials: 'same-origin' }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
