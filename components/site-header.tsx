'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiRequest } from '../src/shared/api-client';
import { useHealth } from '../hooks/use-health';
import type { Quota, User } from '../src/shared/types';
import { ProviderBadge } from './provider-badge';

/**
 * 顶部导航（`docs/prd/pages/P00-设计基准与路由.md` §4.2）：站点名 · 「历史」· 昵称 + 剩余额度 ·
 * 模式小字。固定 56px（`h-14`）+ 底边 1px `border-border`。
 * 额度取 `GET /api/me` 的 `user.nickname` / `quota.remaining` / `quota.limit`。
 */
interface MeResponse {
  user: User;
  quota: Quota;
}

export function SiteHeader() {
  const health = useHealth();
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<MeResponse>('/api/me')
      .then((data) => {
        if (!cancelled) setMe(data);
      })
      .catch(() => {
        /* 额度取不到不影响导航，静默降级 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
