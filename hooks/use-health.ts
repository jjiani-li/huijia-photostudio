'use client';

import { useApiRequest } from './use-api-request';
import { apiRequest, type ApiNotice } from '../src/shared/api-client';
import type { Health } from '../src/shared/types';

/**
 * `GET /api/health` 的一次性读取（`docs/prd/pages/P00-设计基准与路由.md` §4.2、§12）：
 * `provider.mode` → `SiteHeader` 的模式小字；`worker.alive` → 上传页顶部的未存活提示（`ERR-04`）。
 * worker 提示**不走** `ErrorNotice`（它不是 API 错误、没有 `code`，同文档 §8）。
 */
export interface HealthState {
  providerMode: 'mock' | 'real' | null;
  workerAlive: boolean | null;
  loading: boolean;
  error: ApiNotice | null;
}

export const shouldShowWorkerNotice = (state: Pick<HealthState, 'workerAlive'>): boolean =>
  state.workerAlive === false;

const loadHealth = (): Promise<Health> => apiRequest<Health>('/api/health');

export function useHealth(): HealthState {
  const { data, error, loading } = useApiRequest(loadHealth);
  return {
    providerMode: data?.provider.mode ?? null,
    workerAlive: data?.worker.alive ?? null,
    loading,
    error,
  };
}
