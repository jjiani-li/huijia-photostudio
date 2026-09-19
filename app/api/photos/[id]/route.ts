import type { NextRequest } from 'next/server';
import { ok, withErrorHandling, type RouteContext } from '../../../../src/server/http/respond';
import { parsePositiveInt } from '../../../../src/server/http/validate';
import { requireUser } from '../../../../src/server/auth/session';
import { deletePhoto } from '../../../../src/server/domain/deletionService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `DELETE /api/photos/:id`（`docs/prd/spec/03-接口契约.md` §3.2）：软删除，幂等。 */
export const DELETE = withErrorHandling(async (req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser(req);
  const { id } = await ctx.params;
  return ok(deletePhoto({ userId: user.id, photoId: parsePositiveInt(id, 'id') }));
});
