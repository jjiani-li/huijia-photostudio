'use client';

import { useCallback, useEffect, useState } from 'react';
import { toErrorNotice, type ApiNotice } from '../src/shared/api-client';

/**
 * 「进页面取一次」的公共读取（`docs/prd/pages/P00-设计基准与路由.md` §6、§10）：
 * 统一 `cancelled` 卸载护栏与 `toErrorNotice` 映射，供 `use-health` / `use-era-scene-config` /
 * `site-header` 复用。`load` 必须是稳定引用（模块级函数），否则每次渲染都会重取。
 *
 * `reload()` 是页面级「重新加载」的唯一实现（`pages/P02-年代与场景选择.md` §8：请求失败时
 * `ErrorNotice` + 重新加载，不白屏）：把 effect 重跑一遍，不动 `load` 的引用。
 */
export interface ApiRequestState<T> {
  data: T | null;
  error: ApiNotice | null;
  loading: boolean;
  /** 重新取一次（`ErrorNotice` 的 `onRetry` 接它）。 */
  reload: () => void;
}

export function useApiRequest<T>(load: () => Promise<T>): ApiRequestState<T> {
  const [state, setState] = useState<Omit<ApiRequestState<T>, 'reload'>>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => {
    setTick((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
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
  }, [load, tick]);

  return { ...state, reload };
}
