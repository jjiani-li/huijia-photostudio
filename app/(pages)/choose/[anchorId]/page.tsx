import { Suspense } from 'react';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ChoosePanel } from '../../../../components/choose/choose-panel';
import { ChooseSkeleton } from '../../../../components/choose/choose-view';

/**
 * `/choose/[anchorId]`（`docs/prd/pages/P02-年代与场景选择.md` §2、`pages/P00-设计基准与路由.md` §5）：
 * Server Component 只做骨架与 `anchorId` 解析——非法值直接 `notFound()`、**不发请求**；
 * 登录软校验在 `app/(pages)/layout.tsx`，真实数据一律由 `ChoosePanel` 经 `api-client` 取。
 * `Suspense` 是 `useSearchParams()` 的落点（骨架即配置未回时的卡片骨架）。
 */
const anchorIdSchema = z.coerce.number().int().positive();

export default async function ChoosePage({
  params,
}: {
  params: Promise<{ anchorId: string }>;
}): Promise<ReactNode> {
  const { anchorId } = await params;
  const parsed = anchorIdSchema.safeParse(anchorId);
  if (!parsed.success) notFound();

  return (
    <Suspense fallback={<ChooseSkeleton />}>
      <ChoosePanel anchorId={parsed.data} />
    </Suspense>
  );
}
