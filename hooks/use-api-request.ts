'use client';

import { useEffect, useState } from 'react';
import { toErrorNotice, type ApiNotice } from '../src/shared/api-client';

/**
 * 「进页面取一次」的公共读取（`docs/prd/pages/P00-设计基准与路由.md` §6、§10）：
 * 统一 `cancelled` 卸载护栏与 `toErrorNotice` 映射，供 `use-health` / `use-era-scene-config` /
 * `site-header` 复用。`load` 必须是稳定引用（模块级函数），否则每次渲染都会重取。
 */
export interface ApiRequestState<T> {
  data: T | null;
  error: ApiNotice | null;
  loading: boolean;
}

export function useApiRequest<T>(load: () => Promise<T>): ApiRequestState<T> {
  const [state, setState] = useState<ApiRequestState<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ data: null, error: toErrorNotice(err), loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  return state;
}
