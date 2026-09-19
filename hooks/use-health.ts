'use client';

import { useEffect, useState } from 'react';
import { apiRequest, toErrorNotice } from '../src/shared/api-client';
import type { Health } from '../src/shared/types';

/**
 * `GET /api/health` 的一次性读取（`docs/prd/pages/P00-设计基准与路由.md` §4.2、§12）：
 * `provider.mode` → `SiteHeader` 的模式小字；`worker.alive` → 上传页顶部的未存活提示（`ERR-04`）。
 * worker 提示**不走** `ErrorNotice`（它不是 API 错误、没有 `code`，§8）。
 */
export interface HealthState {
  providerMode: 'mock' | 'real' | null;
  workerAlive: boolean | null;
  loading: boolean;
  error: { code: string; message: string } | null;
}

export const shouldShowWorkerNotice = (state: Pick<HealthState, 'workerAlive'>): boolean =>
  state.workerAlive === false;

const INITIAL: HealthState = { providerMode: null, workerAlive: null, loading: true, error: null };

export function useHealth(): HealthState {
  const [state, setState] = useState<HealthState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    apiRequest<Health>('/api/health')
      .then((health) => {
        if (cancelled) return;
        setState({
          providerMode: health.provider.mode,
          workerAlive: health.worker.alive,
          loading: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, loading: false, error: toErrorNotice(err) }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
