'use client';

import type { ReactNode } from 'react';
import type { ApiNotice } from '../../src/shared/api-client';
import type { FeedbackValue } from '../../src/shared/result';
import type { Generation } from '../../src/shared/types';
import type { PollPhase } from '../../hooks/use-job-polling';
import { AsyncStatus } from '../async-status';
import { ErrorNotice } from '../error-notice';
import { WorkerNotice } from '../worker-notice';
import { GenerationHeader } from './generation-header';
import { Lightbox } from './lightbox';
import { PartialNotice } from './partial-notice';
import { ResultGrid } from './result-grid';
import { SafetyNotice } from './safety-notice';

/**
 * `/result/[generationId]` 的展示层（`docs/prd/pages/P03-结果历史与下载.md` §6 的组件树、
 * `pages/P04-失败与情绪安全路径.md` §4）。**无取数、只由 props 驱动**——轮询与请求都在
 * `result-panel.tsx` 里，本组件因此能被静态渲染逐条断言文案与三态。
 */
export interface ResultViewProps {
  generation: Generation;
  /** `useJobPolling` 的相位（超时态显示 `继续看进度`）。 */
  phase: PollPhase;
  /** `GET /api/health` 的 `worker.alive`；未取到为 `null`。 */
  workerAlive: boolean | null;
  /** 正在发反馈请求的结果 id。 */
  pendingFeedbackId: number | null;
  /** 反馈 / retry 的错误（网络与错误码），走 `ErrorNotice`。 */
  notice: ApiNotice | null;
  retryBusy: boolean;
  /** 放大查看的序号；`null` 表示未打开。 */
  openIndex: number | null;
  onFeedback: (resultId: number, feedback: FeedbackValue | null) => void;
  onRetry: () => void;
  onDownloadAll: () => void;
  onOpen: (resultId: number) => void;
  onCloseLightbox: () => void;
  onLightboxIndexChange: (index: number) => void;
  onRefreshNow: () => void;
}

const TERMINAL: ReadonlyArray<Generation['status']> = ['succeeded', 'partial', 'failed'];

/** 非终态的定性进度说明（`pages/P00-设计基准与路由.md` §3.1：不出现百分比、剩余张数与倒计时）。 */
const PROGRESS_LABEL = '正在生成，大概要等一会儿';

export function ResultView({
  generation,
  phase,
  workerAlive,
  pendingFeedbackId,
  notice,
  retryBusy,
  openIndex,
  onFeedback,
  onRetry,
  onDownloadAll,
  onOpen,
  onCloseLightbox,
  onLightboxIndexChange,
  onRefreshNow,
}: ResultViewProps): ReactNode {
  const inProgress = !TERMINAL.includes(generation.status);

  return (
    <section className="flex flex-col gap-2xl animate-fade-in">
      <SafetyNotice />
      <WorkerNotice alive={workerAlive === true} visible={generation.status === 'queued'} />
      <GenerationHeader generation={generation} />

      {inProgress ? <AsyncStatus label={PROGRESS_LABEL} timedOut={phase === 'timedOut'} onRefreshNow={onRefreshNow} /> : null}

      <ResultGrid
        results={generation.results}
        eraName={generation.eraName}
        sceneName={generation.sceneName}
        outputFormat={generation.params.outputFormat}
        pendingFeedbackId={pendingFeedbackId}
        onFeedback={onFeedback}
        onOpen={onOpen}
        onDownloadAll={onDownloadAll}
      />

      <PartialNotice status={generation.status} error={generation.error} onRetry={onRetry} />

      {generation.status === 'succeeded' ? (
        <div>
          <button
            type="button"
            disabled={retryBusy}
            onClick={onRetry}
            className="rounded-pill bg-primary px-lg py-sm text-note text-background disabled:bg-primary-soft disabled:text-ink-soft"
          >
            用同样设定再来一组
          </button>
        </div>
      ) : null}

      <ErrorNotice error={notice} variant="inline" />

      {openIndex !== null ? (
        <Lightbox
          results={generation.results}
          index={openIndex}
          onClose={onCloseLightbox}
          onIndexChange={onLightboxIndexChange}
        />
      ) : null}
    </section>
  );
}

/**
 * 任务未回时的骨架（同 `choose-view.tsx` 的 `ChooseSkeleton`）：只有 `bg-surface` 色块，
 * 没有文字、没有图标、不渲染 `<img>`；`Suspense` 的 fallback 也用它。
 */
export function ResultSkeleton(): ReactNode {
  return (
    <div className="flex flex-col gap-2xl" aria-hidden="true">
      <div className="h-12 w-full rounded-md bg-surface animate-fade-in" />
      <div className="h-48 w-full rounded-md bg-surface animate-fade-in" />
    </div>
  );
}
