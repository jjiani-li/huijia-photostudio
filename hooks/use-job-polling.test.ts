import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJobPoller, type JobPollingOptions } from './use-job-polling';

/**
 * `useJobPolling` 的六条硬规则（`docs/prd/pages/P00-设计基准与路由.md` §7、`spec/03-接口契约.md` §2.1）：
 * 本文件用 fake timers 直接断言框架无关的 `createJobPoller`；React 包装不在 A 层。
 */
interface Job {
  status: string;
}

const poller = (fetchJob: () => Promise<Job>, over: Partial<JobPollingOptions<Job>> = {}) =>
  createJobPoller<Job>({
    fetchJob,
    getStatus: (job) => job.status,
    terminalStatuses: ['succeeded', 'failed'],
    intervalMs: 1000,
    timeoutMs: 10_000,
    enabled: true,
    ...over,
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useJobPolling · 规则 ① 只排下一次 + 首帧立即请求', () => {
  it('enabled 时 start() 立即请求一次；之后按 intervalMs 递归排下一次', async () => {
    vi.useFakeTimers();
    const fetchJob = vi.fn(async (): Promise<Job> => ({ status: 'running' }));
    const p = poller(fetchJob);
    p.start();
    expect(fetchJob).toHaveBeenCalledTimes(1); // 首帧立即
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchJob).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchJob).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('慢响应不叠加：上一次未回来时不排下一次', async () => {
    vi.useFakeTimers();
    let release: (job: Job) => void = () => {};
    const fetchJob = vi.fn(
      () =>
        new Promise<Job>((resolve) => {
          release = resolve;
        }),
    );
    const p = poller(fetchJob);
    p.start();
    expect(fetchJob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); // 远超 interval，但首个请求仍挂起
    expect(fetchJob).toHaveBeenCalledTimes(1);
    release({ status: 'running' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchJob).toHaveBeenCalledTimes(2);
    p.stop();
  });
});

describe('useJobPolling · 规则 ③ 终止即停', () => {
  it('终态 → phase=done，之后不再发请求', async () => {
    vi.useFakeTimers();
    const fetchJob = vi.fn(async (): Promise<Job> => ({ status: 'succeeded' }));
    const p = poller(fetchJob);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.getState().phase).toBe('done');
    expect(p.getState().jobStatus).toBe('succeeded');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });
});

describe('useJobPolling · 规则 ④ 超时不取消能力', () => {
  it('elapsedMs >= timeoutMs → phase=timedOut 且自动停；refreshNow() 可续', async () => {
    vi.useFakeTimers();
    const fetchJob = vi.fn(async (): Promise<Job> => ({ status: 'running' }));
    const p = poller(fetchJob, { intervalMs: 1000, timeoutMs: 2500 });
    p.start();
    // t=0 请求，t=1000、t=2000 各一次；t=3000 时 elapsed=3000>=2500 → timedOut（不再请求）
    await vi.advanceTimersByTimeAsync(3000);
    expect(p.getState().phase).toBe('timedOut');
    expect(fetchJob).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchJob).toHaveBeenCalledTimes(3); // 自动停

    p.refreshNow();
    expect(p.getState().phase).toBe('polling');
    expect(fetchJob).toHaveBeenCalledTimes(4);
    p.stop();
  });
});

describe('useJobPolling · 规则 ⑤ 错误不吞 + 卸载即停', () => {
  it('fetchJob 抛错 → phase=error，error 非空，停止自动轮询', async () => {
    vi.useFakeTimers();
    const fetchJob = vi.fn(async (): Promise<Job> => {
      throw new Error('boom');
    });
    const p = poller(fetchJob);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.getState().phase).toBe('error');
    expect(p.getState().error).toEqual({ code: 'INTERNAL', message: '出了点小问题，请重试' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });

  it('stop() 后不再发请求（组件卸载）', async () => {
    vi.useFakeTimers();
    const fetchJob = vi.fn(async (): Promise<Job> => ({ status: 'running' }));
    const p = poller(fetchJob);
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    p.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchJob).toHaveBeenCalledTimes(1);
  });

  it('enabled=false 时 start() 不发请求', () => {
    vi.useFakeTimers();
    const fetchJob = vi.fn(async (): Promise<Job> => ({ status: 'running' }));
    const p = poller(fetchJob, { enabled: false });
    p.start();
    expect(fetchJob).not.toHaveBeenCalled();
    expect(p.getState().phase).toBe('idle');
  });

  it('enabled 读最新值：false→true 后 start() 能生效（不把 enabled 钉死在首帧）', () => {
    vi.useFakeTimers();
    const fetchJob = vi.fn(async (): Promise<Job> => ({ status: 'running' }));
    let enabled = false;
    const p = createJobPoller<Job>({
      fetchJob,
      getStatus: (job) => job.status,
      terminalStatuses: ['succeeded', 'failed'],
      intervalMs: 1000,
      timeoutMs: 10_000,
      get enabled() {
        return enabled;
      },
    });
    p.start();
    expect(fetchJob).not.toHaveBeenCalled();
    enabled = true;
    p.start();
    expect(fetchJob).toHaveBeenCalledTimes(1);
    p.stop();
  });
});
