import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, withErrorHandling } from '../../../src/server/http/respond';
import { parseJson } from '../../../src/server/http/validate';
import { requireUser } from '../../../src/server/auth/session';
import { ANCHOR_MAX_IMAGES, createAnchor } from '../../../src/server/domain/anchorService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `POST /api/anchors`（`docs/prd/spec/03-接口契约.md` §3.3）：非幂等，每次调用建新行。 */
const createAnchorSchema = z.object({
  photoIds: z.array(z.number().int().positive()).min(1).max(ANCHOR_MAX_IMAGES),
  preprocessedPhotoId: z.number().int().positive().nullish(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = requireUser(req);
  const body = await parseJson(req, createAnchorSchema);
  const anchor = await createAnchor({
    userId: user.id,
    photoIds: body.photoIds,
    preprocessedPhotoId: body.preprocessedPhotoId ?? null,
  });
  return ok({ anchor }, 202);
});
