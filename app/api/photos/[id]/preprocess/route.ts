import type { NextRequest } from 'next/server';
import { ok, withErrorHandling, type RouteContext } from '../../../../../src/server/http/respond';
import { parsePositiveInt } from '../../../../../src/server/http/validate';
import { requireUser } from '../../../../../src/server/auth/session';
import { preprocessPhoto } from '../../../../../src/server/domain/anchorService';
import { toPhotoDto } from '../../../../../src/server/domain/photoService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `POST /api/photos/:id/preprocess`（`docs/prd/spec/03-接口契约.md` §3.2）：同步、幂等、`usable=false` 仍 200。 */
export const POST = withErrorHandling(async (_req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser();
  const { id } = await ctx.params;
  const { photo, quality } = await preprocessPhoto(user.id, parsePositiveInt(id, 'id'));
  return ok({ photo: toPhotoDto(photo), quality });
});
