'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { apiRequest, toErrorNotice, type ApiNotice } from '../../src/shared/api-client';
import { downloadFileName, photoFileHref, quotaLine, type FeedbackValue } from '../../src/shared/result';
import { hasUnauthenticated, loginPath } from '../../src/shared/session';
import type { Generation, GenerationResult, Quota } from '../../src/shared/types';
import { useHealth } from '../../hooks/use-health';
import {
  GENERATION_POLL_INTERVAL_MS,
  GENERATION_POLL_TIMEOUT_MS,
  useJobPolling,
} from '../../hooks/use-job-polling';
import { ErrorNotice } from '../error-notice';
import { ResultSkeleton, ResultView } from './result-view';

/**
 * `/result/[generationId]` 的客户端容器（`docs/prd/pages/P03-结果历史与下载.md` §4、§5、§6）：
 * 轮询任务与结果、写反馈、下载、retry、worker 存活提示、会话失效跳登录。
 * 展示与文案全在 `result-view.tsx`。
 *
 * 轮询规则来自 `docs/prd/spec/03-接口契约.md` §2.1：间隔 2s / 超时 180s、请求串行不叠加、
 * 终态 `{succeeded, partial, failed}` 即停——`useJobPolling` 在终态不再排下一次，因此
 * 已进入终态的任务不会被再次轮询（同文件 §6 禁忌 5）。
 */
export interface ResultPanelProps {
  generationId: number;
}

const TERMINAL_STATUSES: ReadonlyArray<Generation['status']> = ['succeeded', 'partial', 'failed'];

export function ResultPanel({ generationId }: ResultPanelProps): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const health = useHealth();

  const fetchJob = useCallback(
    (): Promise<Generation> =>
      apiRequest<{ generation: Generation }>(`/api/generations/${generationId}`).then((res) => res.generation),
    [generationId],
  );

  const [feedbackOverride, setFeedbackOverride] = useState<Record<number, GenerationResult['userFeedback']>>({});
  const [pendingFeedbackId, setPendingFeedbackId] = useState<number | null>(null);
  const [notice, setNotice] = useState<ApiNotice | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const polling = useJobPolling<Generation>({
    fetchJob,
    getStatus: (job) => job.status,
    terminalStatuses: TERMINAL_STATUSES,
    intervalMs: GENERATION_POLL_INTERVAL_MS,
    timeoutMs: GENERATION_POLL_TIMEOUT_MS,
    enabled: true,
  });

  const job = polling.job;
  // 轮询回来的载荷总是覆盖本地乐观值：下一轮响应一到，反馈覆盖层就清空。
  useEffect(() => {
    setFeedbackOverride({});
  }, [job]);

  // 会话失效（cookie 被清掉而布局的软守卫没拦住）：按 §7 / `API-03` 跳登录并保留 `next`。
  const sessionExpired = hasUnauthenticated([polling.error?.code]);
  useEffect(() => {
    if (sessionExpired) router.replace(loginPath(pathname));
  }, [sessionExpired, pathname, router]);

  const generation =
    job === null ? null : { ...job, results: job.results.map((result) => applyFeedback(result, feedbackOverride)) };

  /** 额度用尽时要一并给出 `quota.remaining` / `quota.limit`（`pages/P00` §8）——只在需要时取一次。 */
  const showQuota = (code: string): void => {
    if (code !== 'QUOTA_EXCEEDED') return;
    apiRequest<{ quota: Quota }>('/api/me')
      .then((res) => setQuota(res.quota))
      .catch(() => setQuota(null));
  };

  const onFeedback = (resultId: number, feedback: FeedbackValue | null): void => {
    setPendingFeedbackId(resultId);
    setNotice(null);
    apiRequest<{ result: GenerationResult }>(`/api/results/${resultId}/feedback`, {
      method: 'POST',
      body: { feedback },
    })
      .then((res) => {
        setFeedbackOverride((current) => ({ ...current, [resultId]: res.result.userFeedback }));
      })
      .catch((err: unknown) => {
        setNotice(toErrorNotice(err));
      })
      .finally(() => {
        setPendingFeedbackId(null);
      });
  };

  const onRetry = (): void => {
    setRetryBusy(true);
    setNotice(null);
    setQuota(null);
    apiRequest<{ generation: Generation }>(`/api/generations/${generationId}/retry`, { method: 'POST' })
      .then((res) => router.replace(`/result/${res.generation.id}`))
      .catch((err: unknown) => {
        const next = toErrorNotice(err);
        setNotice(next);
        showQuota(next.code);
      })
      .finally(() => {
        setRetryBusy(false);
      });
  };

  const onDownloadAll = (): void => {
    if (generation === null) return;
    // 逐张触发，单张失败不影响其余（`pages/P03` §6）：不打包、不新开页面。
    generation.results.forEach((result, ordinal) => {
      const anchor = document.createElement('a');
      anchor.href = photoFileHref(result.photoId);
      anchor.download = downloadFileName(
        generation.eraName,
        generation.sceneName,
        ordinal,
        generation.params.outputFormat,
      );
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    });
  };

  // 一次都没取到时页面无法继续：形态按错误码判（`pages/P00` §8）——`404` 是 `page` 形态 + 「回历史」、
  // 不给重试；其余走 `ErrorNotice` 自己按 code 推出的形态 + 可重试。
  if (generation === null && (polling.error !== null || sessionExpired)) {
    if (sessionExpired) return null; // 已 `replace` 到登录页
    const notFound = polling.error?.code === 'NOT_FOUND';
    return <ErrorNotice error={polling.error} onRetry={notFound ? undefined : polling.refreshNow} />;
  }
  if (generation === null) return <ResultSkeleton />;

  const results = generation.results;
  // 轮询 / 反馈 / retry 的错误都不吞（`pages/P00` §7 规则 ⑤）：轮询的错误与动作错误共用同一个 `ErrorNotice`。
  const visibleNotice = notice ?? polling.error;
  const quotaNotice =
    visibleNotice?.code === 'QUOTA_EXCEEDED' && quota !== null ? quotaLine(quota.remaining, quota.limit) : null;

  return (
    <ResultView
      generation={generation}
      phase={polling.phase}
      inProgress={!TERMINAL_STATUSES.includes(generation.status)}
      workerAlive={health.workerAlive}
      pendingFeedbackId={pendingFeedbackId}
      notice={visibleNotice}
      quotaNotice={quotaNotice}
      retryBusy={retryBusy}
      openIndex={openIndex}
      onFeedback={onFeedback}
      onRetry={onRetry}
      onNoticeRetry={polling.refreshNow}
      onDownloadAll={onDownloadAll}
      onOpen={(resultId) => {
        const index = results.findIndex((result) => result.id === resultId);
        if (index >= 0) setOpenIndex(index);
      }}
      onCloseLightbox={() => setOpenIndex(null)}
      onLightboxIndexChange={setOpenIndex}
      onRefreshNow={polling.refreshNow}
    />
  );
}

/** 反馈覆盖层：只改 `userFeedback`，其余字段以服务端载荷为准。 */
const applyFeedback = (
  result: GenerationResult,
  overrides: Record<number, GenerationResult['userFeedback']>,
): GenerationResult => {
  const next = overrides[result.id];
  return next === undefined ? result : { ...result, userFeedback: next };
};
