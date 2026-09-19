'use client';

import type { ReactNode } from 'react';
import { shouldShowWorkerNotice } from '../hooks/use-health';

/**
 * worker 未存活的**明确报错**（`docs/prd/pages/P03-结果历史与下载.md` §5、
 * `pages/P00-设计基准与路由.md` §4.2、检查项 `ERR-04`）：`status === 'queued'` 且
 * `worker.alive === false` 时立即报错，不得无限转圈。
 *
 * 它**不是 API 错误**（没有 `code`），因此**不走 `ErrorNotice`**（`pages/P00` §8）——
 * 「错误红」只留给真正的错误。文案与 `pnpm worker` 一行命令逐字固定（`pages/P03` §5）。
 */
export interface WorkerNoticeProps {
  /** `GET /api/health` 的 `worker.alive`。 */
  alive: boolean;
  /** 由宿主页决定何时该出现（如 `status === 'queued'`）。 */
  visible: boolean;
}

export function WorkerNotice({ alive, visible }: WorkerNoticeProps): ReactNode {
  // 判据与 `use-health` 的 `shouldShowWorkerNotice` 同源：`alive === false` 才算未存活。
  if (!visible || !shouldShowWorkerNotice({ workerAlive: alive })) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-lg py-md animate-fade-in">
      <p className="text-note text-ink">后台还没启动，图片处理会卡住</p>
      <p className="text-micro text-ink-soft">pnpm worker</p>
    </div>
  );
}
