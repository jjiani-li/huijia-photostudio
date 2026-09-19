import type { NextRequest } from 'next/server';
import { ok, withErrorHandling, type RouteContext } from '../../../../src/server/http/respond';
import { parsePositiveInt } from '../../../../src/server/http/validate';
import { requireUser } from '../../../../src/server/auth/session';
import { getAnchor } from '../../../../src/server/domain/anchorService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/anchors/:id`（`docs/prd/spec/03-接口契约.md` §3.3）：`status !== 'succeeded'` 时
 * `anchorText` / `features` 为 `null`；`failed` 时 `error` 非空。
 * `DELETE`（软删 + 级联）归 `tickets/T07`。
 */
export const GET = withErrorHandling(async (_req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser();
  const { id } = await ctx.params;
  return ok({ anchor: getAnchor(user.id, parsePositiveInt(id, 'id')) });
});
