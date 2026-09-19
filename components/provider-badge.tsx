'use client';

import type { ReactNode } from 'react';

/**
 * `ProviderBadge`：标题栏一行小字，显示 `GET /api/health` 的 `provider.mode`
 * （`真实模式` = PROVIDER=real / `本地模式` = mock，`docs/prd/pages/P00-设计基准与路由.md` §4.2）。
 *
 * worker 未存活的明确报错不住在这里——见 `components/worker-notice.tsx`（`pages/P03` §5、`ERR-04`）。
 */
export function ProviderBadge({ mode }: { mode: 'mock' | 'real' | null }): ReactNode {
  if (mode === null) return null;
  return <span className="text-micro text-ink-soft">{mode === 'real' ? '真实模式' : '本地模式'}</span>;
}
