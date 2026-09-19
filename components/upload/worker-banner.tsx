'use client';

import type { ReactNode } from 'react';
import { WorkerNotice } from '../worker-notice';

/**
 * `/upload` 顶部的 worker 提示（`docs/prd/pages/P01-上传与身份确认.md` §4.2、`pages/P00-设计基准与路由.md` §4.2、
 * 检查项 `ERR-04`）：复用 `components/worker-notice.tsx`，只在 `alive === false` 时出现，
 * **不禁用页面上任何操作**。
 */
export interface WorkerBannerProps {
  /** `GET /api/health` 的 `worker.alive`；未取到为 `null`（不得当成未启动）。 */
  alive: boolean | null;
}

export function WorkerBanner({ alive }: WorkerBannerProps): ReactNode {
  return <WorkerNotice alive={alive} visible />;
}
