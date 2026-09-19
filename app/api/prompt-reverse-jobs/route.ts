import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, withErrorHandling } from '../../../src/server/http/respond';
import { parseJson } from '../../../src/server/http/validate';
import { requireUser } from '../../../src/server/auth/session';
import { createReverseJob } from '../../../src/server/domain/reverseService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/prompt-reverse-jobs`（`docs/prd/spec/03-接口契约.md` §3.8）：非幂等，每次调用建新行，
 * 返回 `202 { job }`（`status='queued'`）。照片可为 `original` 或 `preprocessed`；
 * 不占 `usage_counters.images` 额度。
 */
const createReverseJobSchema = z.object({
  photoId: z.number().int().positive(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = requireUser(req);
  const body = await parseJson(req, createReverseJobSchema);
  return ok({ job: createReverseJob({ userId: user.id, photoId: body.photoId }) }, 202);
});
