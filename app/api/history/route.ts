import type { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '../../../src/server/http/respond';
import { decodeCursor, encodeCursor } from '../../../src/server/http/cursor';
import { requireUser } from '../../../src/server/auth/session';
import { appError } from '../../../src/server/domain/errors';
import { listHistoryByUser } from '../../../src/server/db/repositories/anchors';
import { findActivePhotoForUser } from '../../../src/server/db/repositories/photos';
import { listRecentByAnchors } from '../../../src/server/db/repositories/generations';
import { toPhotoThumbDto } from '../../../src/server/domain/photoService';
import { toGenerationDto } from '../../../src/server/domain/generationService';
import type { Generation, HistoryItem } from '../../../src/shared/types';

/**
 * `GET /api/history`（`docs/prd/spec/03-接口契约.md` §3.6、`modules/M08-账号历史与彻底删除.md` §4）。
 * 只读、允许直连 repository；`cursor` 是不透明串，前端只回传不解析。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** 每锚点最多返回的最近生成条数（`modules/M08` §4）。 */
const GENERATIONS_PER_ANCHOR = 10;

const parseLimit = (raw: string | null): number => {
  if (raw === null) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw appError('INVALID_PARAM', { fields: { limit: ['必须是 [1,50] 的整数'] } });
  }
  return value;
};

/** 「第一个未软删的 `input_photo_ids` 行」（`modules/M08` §3.2 的原图口径）。 */
const firstActiveInputPhoto = (
  userId: number,
  inputPhotoIds: number[],
): ReturnType<typeof findActivePhotoForUser> => {
  for (const id of inputPhotoIds) {
    const photo = findActivePhotoForUser(id, userId);
    if (photo !== null) return photo;
  }
  return null;
};

const withThumbGenerations = (records: ReturnType<typeof listRecentByAnchors>): Generation[] =>
  records.map((record) => {
    const dto = toGenerationDto(record);
    return { ...dto, results: dto.results.map((result) => ({ ...result, url: `${result.url}?w=400` })) };
  });

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = requireUser(req);
  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor);

  const rows = listHistoryByUser(user.id, {
    limit: limit + 1,
    cursorCreatedAt: cursor?.createdAt ?? null,
    cursorId: cursor?.id ?? null,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const generationRecords = listRecentByAnchors(
    user.id,
    page.map((anchor) => anchor.id),
    GENERATIONS_PER_ANCHOR,
  );
  const byAnchor = new Map<number, typeof generationRecords>();
  for (const record of generationRecords) {
    const list = byAnchor.get(record.anchorId);
    if (list === undefined) byAnchor.set(record.anchorId, [record]);
    else list.push(record);
  }

  const items: HistoryItem[] = [];
  for (const anchor of page) {
    const source = firstActiveInputPhoto(user.id, anchor.inputPhotoIds);
    if (source === null) continue; // SQL 的 EXISTS 已保证，这里只是兜底
    const preprocessed =
      anchor.preprocessedPhotoId === null
        ? null
        : findActivePhotoForUser(anchor.preprocessedPhotoId, user.id);
    items.push({
      anchorId: anchor.id,
      anchorText: anchor.anchorText ?? '',
      confirmedAt: anchor.confirmedAt,
      sourcePhoto: toPhotoThumbDto(source),
      preprocessedPhoto: preprocessed === null ? null : toPhotoThumbDto(preprocessed),
      generations: withThumbGenerations(byAnchor.get(anchor.id) ?? []),
    });
  }

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : null;
  return ok({ items, nextCursor });
});
