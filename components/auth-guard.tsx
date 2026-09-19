'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/**
 * 登录软重定向（`docs/prd/pages/P00-设计基准与路由.md` §5.1 规则 ③）：`app/(pages)/layout.tsx` 在服务端
 * 用 `cookies().has('sid')` 决定是否挂载本组件；带上 `next=<当前路径>` 回到原页。
 * 服务端仍是唯一裁判——真实会话失效时，页面级请求会拿到 `401 UNAUTHENTICATED`（§8）。
 *
 * 说明：App Router 的 `layout` 读不到当前 pathname，故 `next` 由客户端的 `usePathname()` 补全。
 */
export function AuthGuard({ hasSession }: { hasSession: boolean }): null {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    // `/` 首页是公开页（`docs/prd/pages/P01-上传与身份确认.md` §4.1）：软重定向只作用于本站其余页面
    // （`pages/P00-设计基准与路由.md` §5.1 规则 ③ 的例外）；真实会话判据仍在各页的请求上。
    if (!hasSession && pathname !== '/') {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [hasSession, pathname, router]);

  return null;
}
