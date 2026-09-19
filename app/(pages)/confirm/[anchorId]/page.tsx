import { Suspense } from 'react';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ConfirmPanel } from '../../../../components/confirm/confirm-panel';
import { ConfirmSkeleton } from '../../../../components/confirm/confirm-view';

/**
 * `/confirm/[anchorId]`（`docs/prd/pages/P01-上传与身份确认.md` §2、§4.3、
 * `pages/P00-设计基准与路由.md` §5）：Server Component 只做骨架与 `anchorId` 解析——非法值直接
 * `notFound()`、**不发请求**；登录软校验在 `app/(pages)/layout.tsx`，真实数据一律由 `ConfirmPanel`
 * 经 `api-client` 取。`Suspense` 的 fallback 即首个响应未回时的骨架。
 */
const anchorIdSchema = z.coerce.number().int().positive();

export default async function ConfirmPage({
  params,
}: {
  params: Promise<{ anchorId: string }>;
}): Promise<ReactNode> {
  const { anchorId } = await params;
  const parsed = anchorIdSchema.safeParse(anchorId);
  if (!parsed.success) notFound();

  return (
    <Suspense fallback={<ConfirmSkeleton />}>
      <ConfirmPanel anchorId={parsed.data} />
    </Suspense>
  );
}
