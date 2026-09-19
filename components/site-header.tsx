'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { apiRequest } from '../src/shared/api-client';
import { useApiRequest } from '../hooks/use-api-request';
import { useHealth } from '../hooks/use-health';
import type { Quota, User } from '../src/shared/types';
import { ProviderBadge } from './provider-badge';

/**
 * 顶部导航（`docs/prd/pages/P00-设计基准与路由.md` §4.2）：站点名 · 「历史」· 昵称 + 剩余额度 ·
 * 模式小字。固定 56px（`h-14`）+ 底边 1px `border-border`。
 * 额度取 `GET /api/me` 的 `user.nickname` / `quota.remaining` / `quota.limit`。
 */
export interface MeResponse {
  user: User;
  quota: Quota;
}

const loadMe = (): Promise<MeResponse> => apiRequest<MeResponse>('/api/me');

const meLoaders = new Map<string, () => Promise<MeResponse>>();

/**
 * 把 `GET /api/me` 的取数绑到当前路径上（`pages/P00` §10：`POST /api/generations` 预扣张数后要
 * 重拉刷新额度）。`(pages)` 布局在站内跳转时不重挂载，所以「进页面取一次」必须由路径变化触发：
 * 同一路径返回同一个 loader 引用（`useApiRequest` 不重取），换路径换新的引用（重取一次）。
 */
export const meLoaderFor = (pathname: string): (() => Promise<MeResponse>) => {
  const cached = meLoaders.get(pathname);
  if (cached !== undefined) return cached;
  const loader = (): Promise<MeResponse> => loadMe();
  meLoaders.set(pathname, loader);
  return loader;
};

export function SiteHeader() {
  const health = useHealth();
  const { data: me } = useApiRequest(meLoaderFor(usePathname()));

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-xl">
      <nav className="flex items-center gap-lg">
        <Link href="/" className="font-serif text-heading text-ink">
          回家照相馆
        </Link>
        <Link href="/history" className="text-note text-ink-soft hover:text-ink">
          历史
        </Link>
      </nav>
      <div className="flex items-center gap-lg">
        {me !== null ? (
          <span className="text-micro text-ink-soft">
            {me.user.nickname} · 额度 {me.quota.remaining}/{me.quota.limit}
          </span>
        ) : null}
        <ProviderBadge mode={health.providerMode} />
      </div>
    </header>
  );
}
