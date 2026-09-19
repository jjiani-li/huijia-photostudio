/**
 * 会话失效的前端落点（`docs/prd/pages/P02-年代与场景选择.md` §8、`pages/P03-结果历史与下载.md` §7、
 * `pages/P00-设计基准与路由.md` §5.1 规则 ③）：`app/(pages)/layout.tsx` 只做 cookie 存在性软校验，
 * 真实会话失效要由页面级请求的 `401 UNAUTHENTICATED` 接住——跳登录并保留 `next`，不留一个打不开的页面。
 */
export const loginPath = (pathname: string): string => `/login?next=${encodeURIComponent(pathname)}`;

/** 任一取数回 `UNAUTHENTICATED` 即视为会话失效（其余错误码仍走 `ErrorNotice`，不白屏）。 */
export const hasUnauthenticated = (codes: readonly (string | undefined)[]): boolean =>
  codes.includes('UNAUTHENTICATED');
