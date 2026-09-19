'use client';

import type { ReactNode } from 'react';
import type { Photo, Quality } from '../../src/shared/types';
import {
  BASELINE_TAG_COPY,
  KEEP_THIS_COPY,
  MANUAL_BASELINE_COPY,
  REMOVE_COPY,
  cardLabel,
  qualitySummary,
  type CardPhase,
} from './uploads';

/**
 * 一张照片的卡片（`docs/prd/pages/P01-上传与身份确认.md` §4.2 的 `PhotoQualityCard`）：
 * 缩略图 / 质量摘要 / `warnings` 原样列表 / `advice` 块 / 基准标记。
 *
 * - `quality.warnings[]` 与 `quality.advice` 是服务端产出，**原样展示、不改写不翻译**
 *   （`modules/M02-预处理与质量评分.md` §6.1、§6.2）；`advice === null` 时不渲染该块；
 * - `usable = false` 时不作默认基准（排序交给 `selectBaseline`），给一个次级按钮 `仍然用这张`，
 *   点了就以它为准继续走 `POST /api/anchors`（`pages/P01` §6 降级项 2）；
 * - 图片一律用响应里的 `url`，**不构造路径**（`spec/03-接口契约.md` §6 禁忌 3）。
 */
export interface PhotoQualityCardProps {
  /** 仍在跑的相位（`uploading` / `preprocessing`）；`ready` 由质量摘要代替。 */
  phase: CardPhase;
  fileName: string;
  /** `kind='original'` 的行；上传成功前为 `null`。 */
  photo: Photo | null;
  quality: Quality | null;
  /** 是否是当前基准图。 */
  isBaseline: boolean;
  onRemove: () => void;
  onSetBaseline: () => void;
}

export function PhotoQualityCard({
  phase,
  fileName,
  photo,
  quality,
  isBaseline,
  onRemove,
  onSetBaseline,
}: PhotoQualityCardProps): ReactNode {
  const label = cardLabel(phase);
  const advice = quality?.advice ?? null;
  return (
    <article className="flex gap-lg rounded-md border border-border bg-surface p-lg animate-fade-in">
      {photo === null ? (
        <div className="h-24 w-24 shrink-0 rounded-md bg-background" />
      ) : (
        <img src={photo.url} alt={fileName} className="h-24 w-24 shrink-0 rounded-md object-cover" />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-sm">
        <p className="truncate text-note text-ink-soft">{fileName}</p>
        {label === null ? null : <p className="text-note text-ink">{label}</p>}

        {quality === null ? (
          <div className="flex items-center">
            <button type="button" onClick={onRemove} className="text-note text-ink-soft underline">
              {REMOVE_COPY}
            </button>
          </div>
        ) : (
          <>
            <p className="text-body text-ink">{qualitySummary(quality)}</p>
            {isBaseline ? <p className="text-note text-ink">{BASELINE_TAG_COPY}</p> : null}
            {quality.warnings.length === 0 ? null : (
              <ul className="flex flex-col gap-xs">
                {quality.warnings.map((warning) => (
                  <li key={warning} className="text-note text-ink-soft">
                    {warning}
                  </li>
                ))}
              </ul>
            )}
            {advice === null ? null : <p className="text-note text-ink-soft">{advice}</p>}
            <div className="flex items-center gap-lg">
              {quality.usable ? (
                isBaseline ? null : (
                  <button type="button" onClick={onSetBaseline} className="text-note text-primary underline">
                    {MANUAL_BASELINE_COPY}
                  </button>
                )
              ) : (
                <button type="button" onClick={onSetBaseline} className="text-note text-primary underline">
                  {KEEP_THIS_COPY}
                </button>
              )}
              <button type="button" onClick={onRemove} className="text-note text-ink-soft underline">
                {REMOVE_COPY}
              </button>
            </div>
          </>
        )}
      </div>
    </article>
  );
}
