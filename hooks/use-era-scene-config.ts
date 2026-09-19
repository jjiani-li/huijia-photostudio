'use client';

import { useApiRequest } from './use-api-request';
import { apiRequest, type ApiNotice } from '../src/shared/api-client';
import type { EraSceneConfig } from '../src/shared/types';

/**
 * `GET /api/config/era-scene` 的一次性读取（`docs/prd/pages/P00-设计基准与路由.md` §6、§10、§12）。
 * 标签页内**模块级内存缓存一次**（key 为响应的 `version`），不落 `localStorage`；并发调用共享同一请求。
 * 响应**不含** `promptPack` / `spacePack` / `constraintPack` / `promptOverride`（`API-06`）。
 */
const cache = new Map<string, EraSceneConfig>();
let inflight: Promise<EraSceneConfig> | null = null;

/** 测试用：清空模块级缓存。 */
export const resetEraSceneConfigCache = (): void => {
  cache.clear();
  inflight = null;
};

export const loadEraSceneConfig = (): Promise<EraSceneConfig> => {
  const cached = [...cache.values()][0];
  if (cached !== undefined) return Promise.resolve(cached);
  if (inflight !== null) return inflight;
  inflight = apiRequest<EraSceneConfig>('/api/config/era-scene')
    .then((config) => {
      cache.set(config.version, config);
      return config;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
};

export interface EraSceneConfigState {
  config: EraSceneConfig | null;
  loading: boolean;
  error: ApiNotice | null;
}

export function useEraSceneConfig(): EraSceneConfigState {
  const { data, error, loading } = useApiRequest(loadEraSceneConfig);
  return { config: data, loading, error };
}
