import type { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '../../../src/server/http/respond';
import { appError } from '../../../src/server/domain/errors';
import { decodeCursor, encodeCursor, PHOTO_CURSOR_PREFIX } from '../../../src/server/http/cursor';
import { requireUser } from '../../../src/server/auth/session';
import { toPhotoThumbDto, toPhotoDto, uploadPhoto } from '../../../src/server/domain/photoService';
import { listUnpresentedActivePhotos } from '../../../src/server/db/repositories/photos';

/** 二进制 / multipart 端点不参与静态化（`docs/prd/modules/M01-照片资产与存储.md` §6.2）。 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const parseLimit = (raw: string | null): number => {
  if (raw === null) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw appError('INVALID_PARAM', { fields: { limit: ['必须是 [1,50] 的整数'] } });
  }
  return value;
};

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
 * 呈现**的未软删照片（独立游标，与 §3.6 互不通用）。
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = requireUser(req);
  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor, PHOTO_CURSOR_PREFIX);

  const rows = listUnpresentedActivePhotos(user.id, {
    limit: limit + 1,
    cursorCreatedAt: cursor?.createdAt ?? null,
    cursorId: cursor?.id ?? null,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ createdAt: last.createdAt, id: last.id }, PHOTO_CURSOR_PREFIX)
      : null;
  return ok({ items: page.map(toPhotoThumbDto), nextCursor });
});
