'use client';

import type { ReactNode } from 'react';
import type { ApiNotice } from '../../src/shared/api-client';
import type { HistoryItem, PhotoList } from '../../src/shared/types';
import { ErrorNotice } from '../error-notice';
import { WorkerNotice } from '../worker-notice';
import { ConfirmDialog } from '../confirm-dialog';
import { HistoryChain } from './history-chain';
import { IncompletePhotos } from './incomplete-photos';

/**
 * `/history` 的展示层（`docs/prd/pages/P03-结果历史与下载.md` §7、§8）。
 * **无取数、只由 props 驱动**——分页、删除与再生成都在 `history-panel.tsx` 里，
 * 本组件因此能被静态渲染逐条断言文案与确认弹层。
 */
export type DeleteLevel = 'chain' | 'anchor' | 'photo';

/** 待确认的删除目标：链路级 / 生成部分级用 `sourcePhoto.id` 与 `anchorId`，区块用 `photoId`。 */
export interface DeleteTarget {
  level: DeleteLevel;
  id: number;
}

export interface HistoryViewProps {
  items: HistoryItem[];
  loading: boolean;
  workerAlive: boolean | null;
  /** 链路还有下一页（`nextCursor !== null`）。 */
  hasMore: boolean;
  historyError: ApiNotice | null;
  photos: PhotoList | null;
  photosError: ApiNotice | null;
  /** 删除成功提示（逐行；见 §8）。 */
  noticeLines: string[];
  noticeError: ApiNotice | null;
  dialog: DeleteTarget | null;
  busy: boolean;
  onRegenerate: (generationId: number) => void;
  onRequestDelete: (target: DeleteTarget) => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onLoadMoreChain: () => void;
  onLoadMorePhotos: () => void;
  onReloadPhotos: () => void;
  onReloadHistory: () => void;
}

/** `/history?cursor=<opaque>`（`pages/P00-设计基准与路由.md` §6）：游标**只回传、不解析**。 */
export const historyHref = (cursor: string): string => `/history?cursor=${encodeURIComponent(cursor)}`;

/** 空态文案（`pages/P03` §7）。 */
export const EMPTY_HISTORY_COPY = '这里还没有记录。先去生成一张试试。';

export interface DeleteCopy {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * 三种删除的确认文案（`pages/P03` §7、§8 的逐字文案）。
 * 确认与成功提示都必须写明「删了拿不回来」，不得出现「可以恢复」「回收站」之类措辞（§8 硬要求）。
 */
export const deleteDialogCopy = (level: DeleteLevel): DeleteCopy => {
  if (level === 'chain') {
    return {
      title: '删掉这次记录？',
      body: '照片、人物特征和生成结果都会一起删掉，删了拿不回来。',
      confirmLabel: '删掉',
      cancelLabel: '算了',
    };
  }
  if (level === 'anchor') {
    return {
      title: '只删掉生成的部分？',
      body: '人物特征和生成的照片会删掉，原照片不动。删了拿不回来。',
      confirmLabel: '删掉',
      cancelLabel: '算了',
    };
  }
  return {
    title: '删掉这张照片？',
    body: '照片会删掉，删了拿不回来。',
    confirmLabel: '删掉',
    cancelLabel: '算了',
  };
};

/**
 * 删除成功提示（`pages/P03` §8）：`删掉了` + 一行 `一起删掉了 {cascaded.results} 张生成图`。
 * 「没走完的照片」区块没有链路，只有前一行（§7）；`cascaded` 取不到（已被 `runPurge()` 抹掉的
 * `404`，按「已经删掉了」处理）时同样只有 `删掉了`。
 */
export const deleteSuccessLines = (level: DeleteLevel, cascadedResults: number | null): string[] =>
  level === 'photo' || cascadedResults === null ? ['删掉了'] : ['删掉了', `一起删掉了 ${cascadedResults} 张生成图`];

export function HistoryView({
  items,
  loading,
  workerAlive,
  hasMore,
  historyError,
  photos,
  photosError,
  noticeLines,
  noticeError,
  dialog,
  busy,
  onRegenerate,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onLoadMoreChain,
  onLoadMorePhotos,
  onReloadPhotos,
  onReloadHistory,
}: HistoryViewProps): ReactNode {
  const empty = !loading && items.length === 0 && !hasMore;

  return (
    <section className="flex flex-col gap-2xl animate-fade-in">
      <WorkerNotice alive={workerAlive === true} visible />
      <h1 className="font-serif text-title text-ink">生成过的记录</h1>

      {noticeLines.length > 0 ? (
        <div className="rounded-md bg-surface px-xl py-lg" role="status">
          {noticeLines.map((line) => (
            <p key={line} className="text-note text-ink">
              {line}
            </p>
          ))}
        </div>
      ) : null}

      <ErrorNotice error={noticeError} variant="inline" />

      {loading ? <HistorySkeleton /> : null}
      {historyError !== null ? <ErrorNotice error={historyError} variant="inline" onRetry={onReloadHistory} /> : null}
      {empty ? <p className="text-note text-ink-soft">{EMPTY_HISTORY_COPY}</p> : null}

      <div className="flex flex-col gap-xl">
        {items.map((item) => (
          <HistoryChain
            key={item.anchorId}
            item={item}
            onRegenerate={onRegenerate}
            onDeletePhoto={() => onRequestDelete({ level: 'chain', id: item.sourcePhoto.id })}
            onDeleteAnchor={() => onRequestDelete({ level: 'anchor', id: item.anchorId })}
          />
        ))}
      </div>

      {hasMore ? (
        <div>
          <button type="button" onClick={onLoadMoreChain} className="text-note text-primary underline">
            再往下看
          </button>
        </div>
      ) : null}

      {photos !== null ? (
        <IncompletePhotos
          list={photos}
          onDelete={(photoId) => onRequestDelete({ level: 'photo', id: photoId })}
          onLoadMore={onLoadMorePhotos}
        />
      ) : null}

      {photosError !== null ? <ErrorNotice error={photosError} variant="inline" onRetry={onReloadPhotos} /> : null}

      {dialog !== null ? (
        <ConfirmDialog
          {...deleteDialogCopy(dialog.level)}
          busy={busy}
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
        />
      ) : null}
    </section>
  );
}

/** 首屏未回时的链路骨架（`pages/P03` §7）：只有 `bg-surface` 色块，没有文字与图片。 */
export function HistorySkeleton(): ReactNode {
  return (
    <div className="flex flex-col gap-xl" aria-hidden="true">
      <div className="h-48 w-full rounded-md bg-surface animate-fade-in" />
      <div className="h-48 w-full rounded-md bg-surface animate-fade-in" />
    </div>
  );
}
