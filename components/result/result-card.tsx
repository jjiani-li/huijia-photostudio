'use client';

import type { ReactNode } from 'react';
import type { GenerationResult } from '../../src/shared/types';
import { downloadFileName, photoFileHref, type FeedbackValue } from '../../src/shared/result';
import { AgeDeltaNotice } from './age-delta-notice';
import { EraCheckBadge } from './era-check-badge';
import { FeedbackButtons } from './feedback-buttons';

/**
 * 结果卡（`docs/prd/pages/P03-结果历史与下载.md` §6）：缩略图 + 年代徽标 + 年龄偏差 + 反馈 + 下载。
 * **不展示** `prompt` / `templateVersion` / `params.provider` / `realismScore` / `seed`（`pages/P03` §2）。
 *
 * 下载走 `GET /api/photos/:id/file`（不带 `w` 取原文件，`pages/P03` §4）；文件名由
 * `downloadFileName` 从 `Generation.params.outputFormat` 派生。
 */
export interface ResultCardProps {
  result: GenerationResult;
  eraName: string;
  sceneName: string;
  /** 0 基序号（同组内的第几张）。 */
  ordinal: number;
  outputFormat: 'png' | 'jpeg';
  /** 正在发反馈请求的结果 id；本卡命中时禁用三个按钮。 */
  pendingFeedbackId: number | null;
  onFeedback: (resultId: number, feedback: FeedbackValue | null) => void;
  onOpen: (resultId: number) => void;
}

export function ResultCard({
  result,
  eraName,
  sceneName,
  ordinal,
  outputFormat,
  pendingFeedbackId,
  onFeedback,
  onOpen,
}: ResultCardProps): ReactNode {
  return (
    <figure className="flex flex-col gap-sm rounded-md bg-surface p-lg shadow-soft animate-fade-in">
      <button type="button" onClick={() => onOpen(result.id)} className="block w-full" aria-label={`放大第 ${ordinal + 1} 张`}>
        <img src={result.url} alt={`${eraName} · ${sceneName} 第 ${ordinal + 1} 张`} className="w-full rounded-lg" />
      </button>
      <EraCheckBadge eraCheck={result.eraCheck} />
      <AgeDeltaNotice ageDelta={result.ageDelta} />
      <FeedbackButtons
        resultId={result.id}
        userFeedback={result.userFeedback}
        pending={pendingFeedbackId === result.id}
        onFeedback={onFeedback}
      />
      <a
        href={photoFileHref(result.photoId)}
        download={downloadFileName(eraName, sceneName, ordinal, outputFormat)}
        className="text-note text-primary underline"
      >
        下载这张
      </a>
    </figure>
  );
}
