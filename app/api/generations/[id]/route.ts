import type { NextRequest } from 'next/server';
import { ok, withErrorHandling, type RouteContext } from '../../../../src/server/http/respond';
import { parsePositiveInt } from '../../../../src/server/http/validate';
import { requireUser } from '../../../../src/server/auth/session';
import { readGenerationForUser } from '../../../../src/server/domain/generationService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `GET /api/generations/:id`（`docs/prd/spec/03-接口契约.md` §3.5）：非终态时 `results` 为已有部分。 */
export const GET = withErrorHandling(async (_req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser();
  const { id } = await ctx.params;
  return ok({ generation: readGenerationForUser(user.id, parsePositiveInt(id, 'id')) });
});
