'use client';

import type { ReactNode } from 'react';
import type { GenerationResult } from '../../src/shared/types';
import type { FeedbackValue } from '../../src/shared/result';
import { ResultCard } from './result-card';

/**
 * 结果网格（`docs/prd/pages/P03-结果历史与下载.md` §2、§6）：候选缩略图 + `全部下载`。
 * 网格在 `queued` / `running` 阶段就渲染已到位的候选（`results` 可能是空数组，`pages/P03` §6）。
 * `全部下载` **逐张触发**：单张失败不影响其余（`pages/P03` §6）。
 */
export interface ResultGridProps {
  results: GenerationResult[];
  eraName: string;
  sceneName: string;
  outputFormat: 'png' | 'jpeg';
  pendingFeedbackId: number | null;
  onFeedback: (resultId: number, feedback: FeedbackValue | null) => void;
  onOpen: (resultId: number) => void;
  onDownloadAll: () => void;
}

export function ResultGrid({
  results,
  eraName,
  sceneName,
  outputFormat,
  pendingFeedbackId,
  onFeedback,
  onOpen,
  onDownloadAll,
}: ResultGridProps): ReactNode {
  if (results.length === 0) return null;

  return (
    <section className="flex flex-col gap-lg">
      <div className="grid gap-lg md:grid-cols-2">
        {results.map((result, ordinal) => (
          <ResultCard
            key={result.id}
            result={result}
            eraName={eraName}
            sceneName={sceneName}
            ordinal={ordinal}
            outputFormat={outputFormat}
            pendingFeedbackId={pendingFeedbackId}
            onFeedback={onFeedback}
            onOpen={onOpen}
          />
        ))}
      </div>
      {results.length > 1 ? (
        <div>
          <button type="button" onClick={onDownloadAll} className="text-note text-primary underline">
            全部下载
          </button>
        </div>
      ) : null}
    </section>
  );
}
