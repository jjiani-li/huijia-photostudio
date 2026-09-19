'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import type { ApiNotice } from '../../src/shared/api-client';
import type { Anchor, ConsentScope } from '../../src/shared/types';
import type { PollPhase } from '../../hooks/use-job-polling';
import { AsyncStatus } from '../async-status';
import { ErrorNotice } from '../error-notice';
import { AnchorText } from './anchor-text';
import { CompareView } from './compare-view';
import { ConfirmButton, PRIMARY_ACTION_CLASS } from './confirm-button';
import {
  allConsentsChecked,
  chooseHref,
  CONFIRMED_CTA_COPY,
  CONFIRMED_NOTICE_COPY,
  CONSENT_INCOMPLETE_COPY,
  EXTRACT_STEPS,
  FAILED_FALLBACK_NOTICE,
  RETRY_ANCHOR_COPY,
} from './confirm-logic';
import { ConsentPanel } from './consent-panel';
import { FeatureList } from './feature-list';

/**
 * `/confirm/[anchorId]` 的展示层（`docs/prd/pages/P01-上传与身份确认.md` §4.3 的组件树）。
 * **无状态、无取数**：轮询、勾选与提交都在 `confirm-panel.tsx` 里，本组件因此能被静态渲染
 * 逐条断言文案与每个状态（提取中 / 失败 / 成功 / 已确认）。
 */
export interface ConfirmViewProps {
  anchor: Anchor;
  /** `useJobPolling` 的相位（`timedOut` 时 `AsyncStatus` 追加超时文案与 `继续看进度`）。 */
  phase: PollPhase;
  /** 轮询 / retry 的请求错误（走 `ErrorNotice` 的 inline 形态，可重试）。 */
  notice: ApiNotice | null;
  /** 两项授权的勾选态（初始两项都未勾选）。 */
  checked: Record<ConsentScope, boolean>;
  /** 服务端 `details.fields.consents` 命中的勾选项（高亮，不展示原文）。 */
  invalidScopes: readonly ConsentScope[];
  /** 12 项特征折叠区的展开态（默认折叠）。 */
  featuresOpen: boolean;
  /** `POST /api/anchors/:id/confirm` 进行中（非幂等，期间禁用按钮）。 */
  busy: boolean;
  /** `POST /api/anchors/:id/retry` 进行中。 */
  retryBusy: boolean;
  onToggleConsent: (scope: ConsentScope, checked: boolean) => void;
  onToggleFeatures: () => void;
  onConfirm: () => void;
  onRetry: () => void;
  onRefreshNow: () => void;
}

export function ConfirmView({
  anchor,
  phase,
  notice,
  checked,
  invalidScopes,
  featuresOpen,
  busy,
  retryBusy,
  onToggleConsent,
  onToggleFeatures,
  onConfirm,
  onRetry,
  onRefreshNow,
}: ConfirmViewProps): ReactNode {
  const extracting = anchor.status === 'queued' || anchor.status === 'running';
  const anchorText = anchor.anchorText ?? '';
  const confirmed = anchor.confirmedByUser === true;
  const ready = allConsentsChecked(checked);

  return (
    <section className="flex flex-col gap-2xl animate-fade-in">
      <header className="flex flex-col gap-sm">
        <h1 className="font-serif text-title text-ink">这是照片里的那个人吗</h1>
        <p className="text-note text-ink-soft">下面是系统从照片里读到的外貌特征。先确认一下，是不是他。</p>
      </header>

      {extracting ? (
        // 三步只是文案分段，不与服务端进度绑定（服务端只给 `status`，见 `pages/P01` §4.3）。
        <AsyncStatus
          label={EXTRACT_STEPS.join(' · ')}
          timedOut={phase === 'timedOut'}
          onRefreshNow={onRefreshNow}
        />
      ) : null}

      {anchor.status === 'failed' ? (
        <ErrorNotice
          error={anchor.error ?? FAILED_FALLBACK_NOTICE}
          variant="page"
          action={
            <button
              type="button"
              disabled={retryBusy}
              onClick={onRetry}
              className="text-note text-primary underline disabled:text-ink-soft"
            >
              {RETRY_ANCHOR_COPY}
            </button>
          }
        />
      ) : null}

      {anchor.status === 'succeeded' ? (
        <>
          <CompareView before={anchor.sourcePhotos[0] ?? null} after={anchor.preprocessedPhoto} />

          {anchorText === '' ? null : <AnchorText text={anchorText} />}

          {anchor.features === null ? null : (
            <FeatureList features={anchor.features} open={featuresOpen} onToggle={onToggleFeatures} />
          )}

          {confirmed ? (
            <div className="flex flex-col items-start gap-md">
              <p className="text-note text-ink-soft">{CONFIRMED_NOTICE_COPY}</p>
              <Link href={chooseHref(anchor.id)} className={PRIMARY_ACTION_CLASS}>
                {CONFIRMED_CTA_COPY}
              </Link>
            </div>
          ) : anchorText === '' ? null : (
            // 确认区只在 `status='succeeded'` 且 `anchorText` 非空时渲染（`pages/P01` §4.3 的边界）。
            <div className="flex flex-col gap-lg">
              <ConsentPanel checked={checked} invalid={invalidScopes} onChange={onToggleConsent} />
              <div className="flex flex-col items-start gap-sm">
                <ConfirmButton disabled={!ready} busy={busy} onClick={onConfirm} />
                {ready ? null : <p className="text-note text-ink-soft">{CONSENT_INCOMPLETE_COPY}</p>}
              </div>
            </div>
          )}
        </>
      ) : null}

      <ErrorNotice error={notice} variant="inline" onRetry={onRefreshNow} />
    </section>
  );
}

/**
 * 首个响应未回时的骨架（同 `choose-view.tsx` 的 `ChooseSkeleton`）：只有 `bg-surface` 色块，
 * 没有文字、没有图标、不渲染 `<img>`；`Suspense` 的 fallback 也用它（`pages/P01` §4.3 的 empty 态）。
 */
export function ConfirmSkeleton(): ReactNode {
  return (
    <div className="flex flex-col gap-2xl" aria-hidden="true">
      <div className="h-12 w-full rounded-md bg-surface animate-fade-in" />
      <div className="h-48 w-full rounded-md bg-surface animate-fade-in" />
      <div className="h-24 w-full rounded-md bg-surface animate-fade-in" />
    </div>
  );
}
