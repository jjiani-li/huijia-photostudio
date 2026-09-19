import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, withErrorHandling, type RouteContext } from '../../../../../src/server/http/respond';
import { parseJson, parsePositiveInt } from '../../../../../src/server/http/validate';
import { requireUser } from '../../../../../src/server/auth/session';
import { setResultFeedback } from '../../../../../src/server/domain/generationService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `-2` = 不像他，结果页的出路（`docs/prd/spec/03-接口契约.md` §3.5、`pages/P04-失败与情绪安全路径.md`）。 */
const feedbackSchema = z.object({
  feedback: z.union([z.literal(1), z.literal(-1), z.literal(-2), z.null()]),
});

/** `POST /api/results/:id/feedback`（`spec/03-接口契约.md` §3.5）：写 `user_feedback`。 */
export const POST = withErrorHandling(async (req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser(req);
  const { id } = await ctx.params;
  const body = await parseJson(req, feedbackSchema);
  const result = setResultFeedback(user.id, parsePositiveInt(id, 'id'), body.feedback);
  return ok({ result });
});
