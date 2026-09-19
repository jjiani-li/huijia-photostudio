import type { NextRequest } from 'next/server';
import { ok, withErrorHandling, type RouteContext } from '../../../../../src/server/http/respond';
import { confirmAnchorSchema, parseJson, parsePositiveInt } from '../../../../../src/server/http/validate';
import { requireUser } from '../../../../../src/server/auth/session';
import { confirmAnchor } from '../../../../../src/server/domain/anchorService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/anchors/:id/confirm`（`docs/prd/spec/03-接口契约.md` §3.3）：
 * 请求 `{ confirmed: true, consents: [...两项] }` → 写两项授权、置 `confirmed_by_user`、同事务两条审计。
 */
export const POST = withErrorHandling(async (req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser(req);
  const { id } = await ctx.params;
  const body = await parseJson(req, confirmAnchorSchema);
  return ok(confirmAnchor(user.id, parsePositiveInt(id, 'id'), body.consents));
});
