import type { NextRequest } from 'next/server';
import { ok, withErrorHandling, type RouteContext } from '../../../../../src/server/http/respond';
import { parsePositiveInt } from '../../../../../src/server/http/validate';
import { requireUser } from '../../../../../src/server/auth/session';
import { retryGeneration, toGenerationDto } from '../../../../../src/server/domain/generationService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `POST /api/generations/:id/retry`（`docs/prd/spec/03-接口契约.md` §3.5）：**新行**，`attempt = 0`。 */
export const POST = withErrorHandling(async (_req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser();
  const { id } = await ctx.params;
  const generation = retryGeneration({ userId: user.id, generationId: parsePositiveInt(id, 'id') });
  return ok({ generation: toGenerationDto(generation) }, 202);
});
