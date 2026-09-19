'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { apiRequest, toErrorNotice, type ApiNotice } from '../../src/shared/api-client';
import { hasUnauthenticated, loginPath } from '../../src/shared/session';
import type { Anchor, Photo, Quality } from '../../src/shared/types';
import { pickFiles } from '../../src/shared/upload';
import { useHealth } from '../../hooks/use-health';
import { ReversePromptPanel } from './reverse-prompt-panel';
import { UploadView } from './upload-view';
import {
  anchorRequest,
  extractDisabled,
  isAllUnusable,
  selectBaseline,
  successfulPhotos,
  type UploadCard,
} from './uploads';

/**
 * `/upload` 的客户端容器（`docs/prd/pages/P01-上传与身份确认.md` §4.2、§4.4）：
 * 逐张上传 → 预处理 → 基准图判定 → `POST /api/anchors`，外加 worker 提示与会话失效跳登录。
 * 展示与逐字文案全在 `upload-view.tsx`；文件与进度是**本页 local state**，
 * 不写 URL、不写 `localStorage` / `sessionStorage`（`pages/P00-设计基准与路由.md` §6）。
 */
export function UploadPanel(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const health = useHealth();

  const [cards, setCards] = useState<UploadCard[]>([]);
  /** 选了超过 5 张时未处理的张数（`pages/P01` §4.2）。 */
  const [overflowCount, setOverflowCount] = useState(0);
  /** 用户手选的基准图（原图 id）：只改提交时的 `preprocessedPhotoId`，不重传（`pages/P01` §4.2）。 */
  const [manualPhotoId, setManualPhotoId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<ApiNotice | null>(null);

  const filesRef = useRef(new Map<string, File>());
  const seqRef = useRef(0);
  /** 串行队列：上一张跑完才开下一张（`pages/P01` §4.2 的「逐张上传 / 预处理」）。 */
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const patch = (key: string, next: Partial<UploadCard>): void => {
    setCards((current) => current.map((card) => (card.key === key ? { ...card, ...next } : card)));
  };

  const upload = async (key: string): Promise<void> => {
    const file = filesRef.current.get(key);
    if (file === undefined) return;
    patch(key, { phase: 'uploading', error: null, quality: null, preprocessedPhoto: null });
    try {
      const form = new FormData();
      form.append('file', file);
      const uploaded = await apiRequest<{ photo: Photo }>('/api/photos', { method: 'POST', formData: form });
      patch(key, { photo: uploaded.photo, phase: 'preprocessing' });
      const processed = await apiRequest<{ photo: Photo; quality: Quality }>(
        `/api/photos/${uploaded.photo.id}/preprocess`,
        { method: 'POST' },
      );
      patch(key, { preprocessedPhoto: processed.photo, quality: processed.quality, phase: 'ready' });
    } catch (err) {
      // 失败只影响这一张：该行进 `UploadErrorList`，其余卡不动（`pages/P01` §4.2）。
      patch(key, { phase: 'error', error: toErrorNotice(err) });
    }
  };

  const enqueue = (key: string): void => {
    queueRef.current = queueRef.current.then(() => upload(key)).catch(() => undefined);
  };

  const onPick = (files: File[]): void => {
    const added = files.map((file) => {
      const key = `photo-${seqRef.current}`;
      seqRef.current += 1;
      filesRef.current.set(key, file);
      return { key, file };
    });
    // 上限判定复用 `src/shared/upload.ts` 的 `pickFiles`：按**整批选择顺序**取前 5 张
    //（`pages/P01` §4.2）。既有卡在序列里永远排在新增卡之前，所以超限只会挤掉本次新选的。
    const { selected, overflow } = pickFiles(
      [...cards.map((card) => card.key), ...added.map((item) => item.key)],
    );
    const keep = new Set(selected);
    for (const key of [...filesRef.current.keys()]) {
      // 超出上限的既有卡不再呈现；它的上传结果也就落空了（本页删除只发生在 local state）。
      if (!keep.has(key)) filesRef.current.delete(key);
    }
    setOverflowCount(overflow.length);
    setCards((current) => [
      ...current.filter((card) => keep.has(card.key)),
      ...added
        .filter((item) => keep.has(item.key))
        .map((item) => ({
          key: item.key,
          fileName: item.file.name,
          phase: 'uploading' as const,
          photo: null,
          preprocessedPhoto: null,
          quality: null,
          error: null,
        })),
    ]);
    for (const item of added) {
      if (keep.has(item.key)) enqueue(item.key);
    }
  };

  const onRemove = (key: string): void => {
    filesRef.current.delete(key);
    setCards((current) => current.filter((card) => card.key !== key));
  };

  const onSetBaseline = (key: string): void => {
    const card = cards.find((item) => item.key === key);
    if (card?.photo == null) return;
    setManualPhotoId(card.photo.id);
  };

  const onRetry = (key: string): void => {
    setCards((current) =>
      current.map((card) => (card.key === key ? { ...card, phase: 'uploading', error: null } : card)),
    );
    enqueue(key);
  };

  const onSubmit = (): void => {
    // 判据与按钮的 `disabled` 同源（`pages/P01` §4.2）：置灰时一个请求都不发。
    if (extractDisabled({ cards, manualPhotoId, busy })) return;
    const request = anchorRequest(cards, selectBaseline(cards, manualPhotoId));
    if (request === null) return;
    setBusy(true);
    setSubmitError(null);
    apiRequest<{ anchor: Anchor }>('/api/anchors', { method: 'POST', body: request })
      .then((res) => router.push(`/confirm/${res.anchor.id}`))
      .catch((err: unknown) => setSubmitError(toErrorNotice(err)))
      .finally(() => setBusy(false));
  };

  // 会话失效（cookie 被清掉而布局的软守卫没拦住）：跳登录并保留 `next`（`pages/P00` §5.1 规则 ③）。
  const sessionExpired = hasUnauthenticated([submitError?.code, ...cards.map((card) => card.error?.code)]);
  useEffect(() => {
    if (sessionExpired) router.replace(loginPath(pathname));
  }, [sessionExpired, pathname, router]);

  const baseline = selectBaseline(cards, manualPhotoId);

  return (
    <UploadView
      cards={cards}
      overflowCount={overflowCount}
      baselineKey={baseline?.key ?? null}
      workerAlive={health.workerAlive}
      allUnusable={isAllUnusable(cards)}
      disabled={extractDisabled({ cards, manualPhotoId, busy })}
      busy={busy}
      submitError={submitError}
      reverse={
        <ReversePromptPanel photos={successfulPhotos(cards)} baselinePhotoId={baseline?.photo?.id ?? null} />
      }
      onPick={onPick}
      onRemove={onRemove}
      onSetBaseline={onSetBaseline}
      onRetry={onRetry}
      onSubmit={onSubmit}
    />
  );
}
