import type { ReactNode } from 'react';
import type { ApiNotice } from '../../src/shared/api-client';
import { ErrorNotice } from '../error-notice';
import { ExtractCta } from './extract-cta';
import { FilePicker } from './file-picker';
import { FooterNote } from './footer-note';
import { PhotoQualityCard } from './photo-quality-card';
import { UploadErrorList } from './upload-error-list';
import { WorkerNotice } from '../worker-notice';
import {
  ALL_UNUSABLE_COPY,
  EMPTY_COPY,
  OVERFLOW_COPY,
  UPLOAD_ACCEPT,
  UPLOAD_DESCRIPTION,
  UPLOAD_TITLE,
  errorRows,
  visibleCards,
  type UploadCard,
} from './uploads';

/**
 * `/upload` 的展示层（`docs/prd/pages/P01-上传与身份确认.md` §4.2 的组件树）。
 * **无状态、无取数**：文件与请求都归 `upload-panel.tsx`，这里只按 props 画出来，
 * 因此可以被静态渲染逐条断言逐字文案与置灰状态。
 *
 * 反推面板以 `reverse` 插槽传入，保持本组件不依赖网络（`pages/P01` §4.4）。
 */
export interface UploadViewProps {
  cards: readonly UploadCard[];
  /** 选了超过 5 张时，未处理的张数（> 0 才提示，`pages/P01` §4.2）。 */
  overflowCount: number;
  /** 当前基准卡的 `key`；`null` = 还没有基准。 */
  baselineKey: string | null;
  /** `GET /api/health` 的 `worker.alive`；未取到为 `null`。 */
  workerAlive: boolean | null;
  /** 都跑完了但没有一张 `usable = true`（`isAllUnusable`）。 */
  allUnusable: boolean;
  /** 主按钮置灰（`extractDisabled`）。 */
  disabled: boolean;
  /** `POST /api/anchors` 在途。 */
  busy: boolean;
  submitError: ApiNotice | null;
  /** 反推面板插槽（至少有一张上传成功的照片时才由容器传入）。 */
  reverse: ReactNode;
  onPick: (files: File[]) => void;
  onRemove: (key: string) => void;
  onSetBaseline: (key: string) => void;
  onRetry: (key: string) => void;
  onSubmit: () => void;
}

export function UploadView({
  cards,
  overflowCount,
  baselineKey,
  workerAlive,
  allUnusable,
  disabled,
  busy,
  submitError,
  reverse,
  onPick,
  onRemove,
  onSetBaseline,
  onRetry,
  onSubmit,
}: UploadViewProps): ReactNode {
  const shown = visibleCards(cards);
  return (
    <section className="flex flex-col gap-2xl animate-fade-in">
      <WorkerNotice alive={workerAlive} visible />

      <header className="flex flex-col gap-sm">
        <h1 className="font-serif text-title text-ink">{UPLOAD_TITLE}</h1>
        <p className="text-note text-ink-soft">{UPLOAD_DESCRIPTION}</p>
      </header>

      <FilePicker multiple accept={UPLOAD_ACCEPT} onPick={onPick} />

      {cards.length === 0 ? <p className="text-note text-ink-soft">{EMPTY_COPY}</p> : null}
      {overflowCount > 0 ? <p className="text-note text-ink-soft">{OVERFLOW_COPY}</p> : null}
      {allUnusable ? <p className="text-note text-ink-soft">{ALL_UNUSABLE_COPY}</p> : null}

      {shown.length === 0 ? null : (
        <ul className="flex flex-col gap-lg">
          {shown.map((card) => (
            <li key={card.key}>
              <PhotoQualityCard
                phase={card.phase}
                fileName={card.fileName}
                photo={card.photo}
                quality={card.quality}
                isBaseline={card.key === baselineKey}
                onRemove={() => onRemove(card.key)}
                onSetBaseline={() => onSetBaseline(card.key)}
              />
            </li>
          ))}
        </ul>
      )}

      <UploadErrorList rows={errorRows(cards)} onRetry={onRetry} />

      {reverse}

      <ExtractCta disabled={disabled} busy={busy} onClick={onSubmit} />

      <ErrorNotice error={submitError} variant="inline" />

      <FooterNote />
    </section>
  );
}

/**
 * 页面骨架（同 `choose-view.tsx` 的 `ChooseSkeleton`）：只有 `bg-surface` 色块，
 * 没有文字、没有图标；`Suspense` 的 fallback 也用它。
 */
export function UploadSkeleton(): ReactNode {
  return (
    <div className="flex flex-col gap-2xl" aria-hidden="true">
      <div className="h-12 w-full rounded-md bg-surface animate-fade-in" />
      <div className="h-24 w-full rounded-md bg-surface animate-fade-in" />
      <div className="h-24 w-full rounded-md bg-surface animate-fade-in" />
    </div>
  );
}
