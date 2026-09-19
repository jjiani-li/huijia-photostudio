import type { NextRequest } from 'next/server';
import { ok, withErrorHandling, type RouteContext } from '../../../../../src/server/http/respond';
import { parsePositiveInt } from '../../../../../src/server/http/validate';
import { requireUser } from '../../../../../src/server/auth/session';
import { retryAnchor } from '../../../../../src/server/domain/anchorService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `POST /api/anchors/:id/retry`（`docs/prd/spec/03-接口契约.md` §3.3）：**新行**，`attempt = 旧 + 1`。 */
export const POST = withErrorHandling(async (req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser(req);
  const { id } = await ctx.params;
  return ok({ anchor: retryAnchor(user.id, parsePositiveInt(id, 'id')) }, 202);
});
