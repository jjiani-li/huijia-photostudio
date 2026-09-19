'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ApiClientError, apiRequest, toErrorNotice, type ApiNotice } from '../../src/shared/api-client';
import { hasUnauthenticated, loginPath } from '../../src/shared/session';
import type { Generation, HistoryItem, PhotoList } from '../../src/shared/types';
import { useApiRequest } from '../../hooks/use-api-request';
import { useHealth } from '../../hooks/use-health';
import { HistoryView, deleteSuccessLines, historyHref, type DeleteTarget } from './history-view';

/**
 * `/history` 的客户端容器（`docs/prd/pages/P03-结果历史与下载.md` §7、§8）：
 * 链路分页（`cursor` 写 URL、只回传不解析）、「没走完的照片」区块（**独立游标**、`再往下看` 追加下一页）、
 * 两级删除 + 区块删除（统一 `ConfirmDialog`）、`用同样设定再生成`。展示全在 `history-view.tsx`。
 */
interface HistoryList {
  items: HistoryItem[];
  nextCursor: string | null;
}

interface DeleteResponse {
  ok: boolean;
  cascaded?: { results?: number };
}

const PAGE_LIMIT = 20;

const pageQuery = (cursor: string | null): string =>
  `limit=${PAGE_LIMIT}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;

const loadHistory = (cursor: string | null): Promise<HistoryList> =>
  apiRequest<HistoryList>(`/api/history?${pageQuery(cursor)}`);

/**
 * 「没走完的照片」区块：`GET /api/photos`（`spec/03-接口契约.md` §3.2）。它的游标与 `/api/history`
 * 的**不通用**（编码自带前缀，混用 → `400 INVALID_PARAM`），因此本页两个分页各走各的请求。
 */
const loadPhotosPage = (cursor: string | null): Promise<PhotoList> =>
  apiRequest<PhotoList>(`/api/photos?${pageQuery(cursor)}`);

export function HistoryPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const cursor = useSearchParams().get('cursor');

  // `useCallback` 让同游标稳定（`useApiRequest` 不重取）、换游标换引用（重取一次）。
  const historyLoader = useCallback(() => loadHistory(cursor), [cursor]);
  const historyState = useApiRequest(historyLoader);

  const [photos, setPhotos] = useState<PhotoList | null>(null);
  const [photosError, setPhotosError] = useState<ApiNotice | null>(null);
  const health = useHealth();

  const [dialog, setDialog] = useState<DeleteTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [noticeLines, setNoticeLines] = useState<string[]>([]);
  const [noticeError, setNoticeError] = useState<ApiNotice | null>(null);

  /** `append=true` 是区块的 `再往下看`：把下一页接在已有的照片后面（不是把上一页换掉）。 */
  const loadPhotos = useCallback((nextCursor: string | null, append: boolean): void => {
    setPhotosError(null);
    loadPhotosPage(nextCursor)
      .then((page) => {
        setPhotos((current) =>
          append && current !== null
            ? { items: [...current.items, ...page.items], nextCursor: page.nextCursor }
            : page,
        );
      })
      .catch((err: unknown) => setPhotosError(toErrorNotice(err)));
  }, []);

  useEffect(() => {
    loadPhotos(null, false);
  }, [loadPhotos]);

  // 会话失效（cookie 被清掉而布局的软守卫没拦住）：按 §7 跳登录并保留 `next`。
  const sessionExpired = hasUnauthenticated([historyState.error?.code, photosError?.code]);
  useEffect(() => {
    if (sessionExpired) router.replace(loginPath(pathname));
  }, [sessionExpired, pathname, router]);

  const reload = (): void => {
    historyState.reload();
    loadPhotos(null, false);
  };

  const onRegenerate = (generationId: number): void => {
    setNoticeError(null);
    apiRequest<{ generation: Generation }>(`/api/generations/${generationId}/retry`, { method: 'POST' })
      .then((res) => router.push(`/result/${res.generation.id}`))
      .catch((err: unknown) => setNoticeError(toErrorNotice(err)));
  };

  /**
   * 确认删除（`pages/P03` §8）：链路级与区块删除走 `DELETE /api/photos/:id`，
   * 生成部分级走 `DELETE /api/anchors/:id`；两者都幂等，已被 `runPurge()` 抹掉的行返回 `404`，
   * 按「已经删掉了」处理、不报错（`modules/M08-账号历史与彻底删除.md` §9 待定决策 3）。
   */
  const onConfirmDelete = (): void => {
    if (dialog === null) return;
    const target = dialog;
    setBusy(true);
    setNoticeError(null);
    const path = target.level === 'anchor' ? `/api/anchors/${target.id}` : `/api/photos/${target.id}`;
    apiRequest<DeleteResponse>(path, { method: 'DELETE' })
      .then((res) => {
        setNoticeLines(deleteSuccessLines(target.level, res.cascaded?.results ?? 0));
        reload();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiClientError && err.code === 'NOT_FOUND') {
          setNoticeLines(deleteSuccessLines(target.level, null));
          reload();
          return;
        }
        setNoticeError(toErrorNotice(err));
      })
      .finally(() => {
        setBusy(false);
        setDialog(null);
      });
  };

  return (
    <HistoryView
      items={historyState.data?.items ?? []}
      loading={historyState.loading}
      workerAlive={health.workerAlive}
      hasMore={(historyState.data?.nextCursor ?? null) !== null}
      historyError={sessionExpired ? null : historyState.error}
      photos={photos}
      photosError={sessionExpired ? null : photosError}
      noticeLines={noticeLines}
      noticeError={noticeError}
      dialog={dialog}
      busy={busy}
      onRegenerate={onRegenerate}
      onRequestDelete={(target) => {
        setNoticeError(null);
        setNoticeLines([]);
        setDialog(target);
      }}
      onConfirmDelete={onConfirmDelete}
      onCancelDelete={() => setDialog(null)}
      onLoadMoreChain={() => {
        const next = historyState.data?.nextCursor ?? null;
        if (next !== null) router.push(historyHref(next));
      }}
      onLoadMorePhotos={() => {
        if (photos !== null && photos.nextCursor !== null) loadPhotos(photos.nextCursor, true);
      }}
      onReloadPhotos={() => loadPhotos(null, false)}
      onReloadHistory={historyState.reload}
    />
  );
}
