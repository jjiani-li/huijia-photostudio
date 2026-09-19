import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, withErrorHandling } from '../../../src/server/http/respond';
import { parseJson } from '../../../src/server/http/validate';
import { requireUser } from '../../../src/server/auth/session';
import { createGeneration, toGenerationDto } from '../../../src/server/domain/generationService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/generations`（`docs/prd/spec/03-接口契约.md` §3.5）：非幂等，每次调用建新行。
 * 第 0 道关卡就在本文件的 zod（`count` 缺省 2），失败即 `INVALID_PARAM` 且发生在 8 步之前。
 */
const createGenerationSchema = z.object({
  anchorId: z.number().int().positive(),
  eraCode: z.string().min(1),
  sceneId: z.number().int().positive(),
  count: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = requireUser(req);
  const body = await parseJson(req, createGenerationSchema);
  const generation = await createGeneration({
    userId: user.id,
    anchorId: body.anchorId,
    eraCode: body.eraCode,
    sceneId: body.sceneId,
    count: body.count ?? 2,
  });
  return ok({ generation: toGenerationDto(generation) }, 202);
});
