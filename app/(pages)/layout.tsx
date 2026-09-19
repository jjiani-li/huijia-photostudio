import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { AuthGuard } from '../../components/auth-guard';
import { SiteHeader } from '../../components/site-header';

/**
 * `(pages)` 路由组的外壳（`docs/prd/pages/P00-设计基准与路由.md` §2、§4.2、§5.1）：
 * `SiteHeader` + `max-w-content` 内容区 + 登录软校验（`cookies().has('sid')`，真实判据仍在服务端）。
 * `/login` 在该路由组之外，故不被本外壳与软重定向影响。
 */
export default async function PagesLayout({ children }: { children: ReactNode }) {
  const hasSession = (await cookies()).has('sid');
  return (
    <>
      <SiteHeader />
      <AuthGuard hasSession={hasSession} />
      <main className="mx-auto w-full max-w-content px-xl py-2xl">{children}</main>
    </>
  );
}
