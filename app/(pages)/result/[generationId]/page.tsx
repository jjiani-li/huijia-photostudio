import { Suspense } from 'react';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ResultPanel } from '../../../../components/result/result-panel';
import { ResultSkeleton } from '../../../../components/result/result-view';

/**
 * `/result/[generationId]`（`docs/prd/pages/P03-结果历史与下载.md` §2、§6、
 * `pages/P00-设计基准与路由.md` §5.1）：Server Component 只做骨架与 `generationId` 解析——
 * 非法值直接 `notFound()`、**不发请求**；登录软校验在 `app/(pages)/layout.tsx`，
 * 真实数据一律由 `ResultPanel` 经 `api-client` 取。
 */
const generationIdSchema = z.coerce.number().int().positive();

export default async function ResultPage({
  params,
}: {
  params: Promise<{ generationId: string }>;
}): Promise<ReactNode> {
  const { generationId } = await params;
  const parsed = generationIdSchema.safeParse(generationId);
  if (!parsed.success) notFound();

  return (
    <Suspense fallback={<ResultSkeleton />}>
      <ResultPanel generationId={parsed.data} />
    </Suspense>
  );
}
