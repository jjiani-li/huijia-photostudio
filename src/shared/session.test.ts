import { describe, expect, it } from 'vitest';
import { hasUnauthenticated, loginPath } from './session';

/**
 * 会话失效的前端落点（`docs/prd/pages/P02` §8、`pages/P03` §7）：
 * 401 统一跳登录路由并保留 `next`。
 */
describe('loginPath / hasUnauthenticated', () => {
  it('loginPath 带 `next` 且做了 URL 编码', () => {
    expect(loginPath('/choose/7')).toBe('/login?next=%2Fchoose%2F7');
    expect(loginPath('/result/12')).toBe('/login?next=%2Fresult%2F12');
  });

  it('含 UNAUTHENTICATED 即判真（含 undefined 混入）', () => {
    expect(hasUnauthenticated(['UNAUTHENTICATED', undefined])).toBe(true);
    expect(hasUnauthenticated([undefined, 'UNAUTHENTICATED', undefined])).toBe(true);
  });

  it('其余错误码与空值判假', () => {
    for (const codes of [[], [undefined], ['PROVIDER_ERROR'], ['NOT_FOUND', 'INVALID_PARAM']]) {
      expect(hasUnauthenticated(codes), JSON.stringify(codes)).toBe(false);
    }
  });
});
