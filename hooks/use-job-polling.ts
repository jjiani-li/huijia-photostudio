'use client';

import { useEffect, useRef, useState } from 'react';
import { toErrorNotice } from '../src/shared/api-client';

/**
 * 轮询 Hook（`docs/prd/pages/P00-设计基准与路由.md` §7、`spec/03-接口契约.md` §2.1）。
 * 六条硬规则：只排下一次不叠加、`inFlight` 并发护栏、终止即停、超时不取消能力（`refreshNow()` 可续）、
 * 错误不吞、终态不再轮询（第 ⑥ 条由调用方保证：只对非终态 id 传入 `enabled=true`）。
 *
 * 核心循环抽成框架无关的 `createJobPoller`，便于用 fake timers 断言语义；`useJobPolling` 只是它的 React 包装。
 */
export const ANCHOR_POLL_INTERVAL_MS = 1500;
export const ANCHOR_POLL_TIMEOUT_MS = 90_000;
export const GENERATION_POLL_INTERVAL_MS = 2000;
export const GENERATION_POLL_TIMEOUT_MS = 180_000;

export type PollPhase = 'idle' | 'polling' | 'done' | 'timedOut' | 'error';

export interface JobPollingOptions<T> {
  fetchJob: () => Promise<T>;
  getStatus: (job: T) => string;
  terminalStatuses: readonly string[];
  intervalMs: number;
  timeoutMs: number;
  enabled: boolean;
}

export interface JobPollingState<T> {
  job: T | null;
  phase: PollPhase;
  jobStatus: string | null;
  elapsedMs: number;
  error: { code: string; message: string } | null;
  refreshNow: () => void;
}

export interface JobPoller<T> {
  start(): void;
  stop(): void;
  refreshNow(): void;
  getState(): JobPollingState<T>;
  subscribe(listener: () => void): () => void;
}

export const createJobPoller = <T>(options: JobPollingOptions<T>): JobPoller<T> => {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let active = false;
  let startedAt = 0;
  let state: JobPollingState<T> = {
    job: null,
    phase: 'idle',
    jobStatus: null,
    elapsedMs: 0,
    error: null,
    refreshNow: () => refreshNow(),
  };

  function emit(patch: Partial<JobPollingState<T>>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delay: number): void {
    clearTimer();
    timer = setTimeout(() => {
      void tick();
    }, delay);
  }

  async function tick(): Promise<void> {
    if (!active || inFlight) return;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= options.timeoutMs) {
      // 超时：自动轮询停止但保留 refreshNow()（规则 ④）。
      emit({ phase: 'timedOut', elapsedMs: elapsed });
      return;
    }
    inFlight = true;
    try {
      const job = await options.fetchJob();
      const jobStatus = options.getStatus(job);
      const terminal = options.terminalStatuses.includes(jobStatus);
      emit({ job, jobStatus, elapsedMs: Date.now() - startedAt, phase: terminal ? 'done' : 'polling' });
      if (!terminal) schedule(options.intervalMs);
    } catch (err) {
      // 错误不吞：交 ErrorNotice，停止自动轮询（规则 ⑤）。
      emit({ phase: 'error', error: toErrorNotice(err), elapsedMs: Date.now() - startedAt });
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (!options.enabled || active) return;
    active = true;
    startedAt = Date.now();
    emit({ phase: 'polling', error: null, elapsedMs: 0 });
    void tick(); // 首帧立即请求一次（规则 ①）
  }

  function stop(): void {
    active = false;
    inFlight = false;
    clearTimer();
  }

  function refreshNow(): void {
    if (!options.enabled) return;
    if (!active) {
      start();
      return;
    }
    if (inFlight) return;
    startedAt = Date.now(); // 重置计时窗口，让超时后「续一轮」成立
    emit({ phase: 'polling', error: null, elapsedMs: 0 });
    void tick();
  }

  return {
    start,
    stop,
    refreshNow,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export function useJobPolling<T>(options: JobPollingOptions<T>): JobPollingState<T> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [, forceRender] = useState(0);
  const pollerRef = useRef<JobPoller<T> | null>(null);
  pollerRef.current ??= createJobPoller<T>({
    fetchJob: () => optionsRef.current.fetchJob(),
    getStatus: (job) => optionsRef.current.getStatus(job),
    terminalStatuses: options.terminalStatuses,
    intervalMs: options.intervalMs,
    timeoutMs: options.timeoutMs,
    enabled: options.enabled,
  });
  const poller = pollerRef.current;

  useEffect(() => poller.subscribe(() => forceRender((n) => n + 1)), [poller]);

  useEffect(() => {
    if (options.enabled) poller.start();
    else poller.stop();
    return () => poller.stop();
  }, [poller, options.enabled]);

  return poller.getState();
}
