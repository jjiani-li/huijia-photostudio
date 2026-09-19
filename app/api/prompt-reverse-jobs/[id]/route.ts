import type { NextRequest } from 'next/server';
import { ok, withErrorHandling, type RouteContext } from '../../../../src/server/http/respond';
import { parsePositiveInt } from '../../../../src/server/http/validate';
import { requireUser } from '../../../../src/server/auth/session';
import { readReverseJobForUser } from '../../../../src/server/domain/reverseService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/prompt-reverse-jobs/:id`（`docs/prd/spec/03-接口契约.md` §3.8）：非终态时四个产物字段
 * 为 `null`，`status='failed'` 时 `error` 非空；不是自己的任务 → `404 NOT_FOUND`。
 */
export const GET = withErrorHandling(async (req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser(req);
  const { id } = await ctx.params;
  return ok({ job: readReverseJobForUser(user.id, parsePositiveInt(id, 'id')) });
});
