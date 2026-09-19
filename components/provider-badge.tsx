'use client';

import type { ReactNode } from 'react';
import { shouldShowWorkerNotice, type HealthState } from '../hooks/use-health';

/**
 * `ProviderBadge`：标题栏一行小字，显示 `GET /api/health` 的 `provider.mode`
 * （`真实模式` = PROVIDER=real / `本地模式` = mock，`docs/prd/pages/P00-设计基准与路由.md` §4.2）。
 * `WorkerNotice`：worker 未存活提示，**只落上传页顶部**（不是全站），文案 + `pnpm worker`（§4.2、`ERR-04`）。
 */
export function ProviderBadge({ mode }: { mode: 'mock' | 'real' | null }): ReactNode {
  if (mode === null) return null;
  return <span className="text-micro text-ink-soft">{mode === 'real' ? '真实模式' : '本地模式'}</span>;
}

export function WorkerNotice({ health }: { health: Pick<HealthState, 'workerAlive'> }): ReactNode {
  if (!shouldShowWorkerNotice(health)) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-lg py-md animate-fade-in">
      <p className="text-note text-ink">后台还没启动，图片处理会卡住</p>
      <p className="text-micro text-ink-soft">pnpm worker</p>
    </div>
  );
}
