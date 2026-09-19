import type { NextRequest } from 'next/server';
import { withErrorHandling, type RouteContext } from '../../../../../src/server/http/respond';
import { parsePositiveInt } from '../../../../../src/server/http/validate';
import { appError } from '../../../../../src/server/domain/errors';
import { requireUser } from '../../../../../src/server/auth/session';
import { readPhotoForUser } from '../../../../../src/server/domain/photoService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `w` 取值域 `[16, 2048]` 的整数；越界或非整数 → `400 INVALID_PARAM`（不 clamp，`spec/03` §3.2）。 */
const parseWidth = (raw: string | null): number | undefined => {
  if (raw === null) return undefined;
  const width = Number(raw);
  if (!Number.isInteger(width) || width < 16 || width > 2048) {
    throw appError('INVALID_PARAM', { fields: { w: ['必须是 [16, 2048] 的整数'] } });
  }
  return width;
};

/** `GET /api/photos/:id/file`（`docs/prd/spec/03-接口契约.md` §3.2）：二进制读图，可选 `?w=` 缩放。 */
export const GET = withErrorHandling(async (req: NextRequest, ctx: RouteContext<{ id: string }>) => {
  const user = requireUser(req);
  const { id } = await ctx.params;
  const width = parseWidth(new URL(req.url).searchParams.get('w'));
  const { body, contentType, generated } = await readPhotoForUser({
    userId: user.id,
    photoId: parsePositiveInt(id, 'id'),
    width,
  });
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'private, max-age=3600',
  });
  if (generated) headers.set('X-AIGC-Generated', 'true');
  return new Response(new Uint8Array(body), { status: 200, headers });
});
