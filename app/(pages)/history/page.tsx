import { Suspense } from 'react';
import type { ReactNode } from 'react';
import { HistoryPanel } from '../../../components/history/history-panel';
import { HistorySkeleton } from '../../../components/history/history-view';

/**
 * `/history`（`docs/prd/pages/P03-结果历史与下载.md` §2、§7）：Server Component 只提供骨架；
 * 登录软校验在 `app/(pages)/layout.tsx`，链路与「没走完的照片」的取数、分页、删除都在 `HistoryPanel`。
 * `Suspense` 是 `useSearchParams()`（链路的 `cursor`）的落点。
 */
export default function HistoryPage(): ReactNode {
  return (
    <Suspense fallback={<HistorySkeleton />}>
      <HistoryPanel />
    </Suspense>
  );
}
