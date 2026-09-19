'use client';

import type { ReactNode } from 'react';

/**
 * 进度态（`docs/prd/pages/P03-结果历史与下载.md` §5、§6、`pages/P00-设计基准与路由.md` §3.1）：
 * **只用定性描述**——不得出现百分比、剩余张数与倒计时；动效统一 `animate-fade-in`。
 * 超时**不自动停**：文案 `还在处理，可以先去别处看看` + 保留 `继续看进度` 按钮（`refreshNow()`）。
 */
export interface AsyncStatusProps {
  /** 进度说明（如 `正在生成，大概要等一会儿`）。 */
  label: string;
  /** 轮询超时态：追加超时文案与 `继续看进度`。 */
  timedOut?: boolean;
  /** 超时后「续一轮」（`useJobPolling` 的 `refreshNow`）。 */
  onRefreshNow?: () => void;
}

const TIMEOUT_COPY = '还在处理，可以先去别处看看';

export function AsyncStatus({ label, timedOut = false, onRefreshNow }: AsyncStatusProps): ReactNode {
  return (
    <div className="flex flex-col gap-sm animate-fade-in" role="status" aria-live="polite">
      <p className="text-note text-ink">{label}</p>
      <div className="h-1 w-full rounded-pill bg-primary-soft" />
      {timedOut ? (
        <div className="flex items-center gap-lg">
          <p className="text-note text-ink-soft">{TIMEOUT_COPY}</p>
          {onRefreshNow !== undefined ? (
            <button type="button" onClick={onRefreshNow} className="text-note text-primary underline">
              继续看进度
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
