import type { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '../../../src/server/http/respond';
import { appError } from '../../../src/server/domain/errors';
import { decodeCursor, PHOTO_CURSOR_PREFIX } from '../../../src/server/http/cursor';
import { pageOf, parseLimit } from '../../../src/server/http/pagination';
import { requireUser } from '../../../src/server/auth/session';
import { toPhotoThumbDto, toPhotoDto, uploadPhoto } from '../../../src/server/domain/photoService';
import { listUnpresentedActivePhotos } from '../../../src/server/db/repositories/photos';

/** 二进制 / multipart 端点不参与静态化（`docs/prd/modules/M01-照片资产与存储.md` §6.2）。 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `POST /api/photos`（`docs/prd/spec/03-接口契约.md` §3.2）：`multipart/form-data`，字段 `file`。 */
export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = requireUser(req);
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (form === null || !(file instanceof File)) {
    throw appError('INVALID_PARAM', { fields: { file: ['缺少文件字段或值不是文件'] } });
  }
  const photo = await uploadPhoto({ userId: user.id, file });
  return ok({ photo: toPhotoDto(photo) }, 201);
});

/**
 * `GET /api/photos`（`spec/03-接口契约.md` §3.2、`modules/M08` §3.2）：列出**没有被 `/api/history`
 * 呈现**的未软删照片（独立游标 `ph|`，与 §3.6 互不通用）。
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = requireUser(req);
  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor, PHOTO_CURSOR_PREFIX);

  const { rows, nextCursor } = pageOf(
    listUnpresentedActivePhotos(user.id, {
      limit: limit + 1,
      cursorCreatedAt: cursor?.createdAt ?? null,
      cursorId: cursor?.id ?? null,
    }),
    limit,
    (photo) => ({ createdAt: photo.createdAt, id: photo.id }),
    PHOTO_CURSOR_PREFIX,
  );
  return ok({ items: rows.map(toPhotoThumbDto), nextCursor });
});
