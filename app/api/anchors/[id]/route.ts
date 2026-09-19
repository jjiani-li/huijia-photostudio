import type { NextRequest } from 'next/server';
import { ok, withErrorHandling, type RouteContext } from '../../../../src/server/http/respond';
import { parsePositiveInt } from '../../../../src/server/http/validate';
import { requireUser } from '../../../../src/server/auth/session';
import { deleteAnchor } from '../../../../src/server/domain/deletionService';
import { getAnchor } from '../../../../src/server/domain/anchorService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/anchors/:id`（`docs/prd/spec/03-接口契约.md` §3.3）：`status !== 'succeeded'` 时
 * `anchorText` / `features` 为 `null`；`failed` 时 `error` 非空。
 */
export const GET = withErrorHandling(async (req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser(req);
  const { id } = await ctx.params;
  return ok({ anchor: getAnchor(user.id, parsePositiveInt(id, 'id')) });
});

/**
 * `DELETE /api/anchors/:id`（`docs/prd/spec/03-接口契约.md` §3.3）：幂等。级联范围与顺序见
 * `docs/prd/modules/M08-账号历史与彻底删除.md` §3.3，实现落在 `src/server/domain/deletionService.ts`。
 */
export const DELETE = withErrorHandling(async (req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser(req);
  const { id } = await ctx.params;
  return ok(deleteAnchor({ userId: user.id, anchorId: parsePositiveInt(id, 'id') }));
});
