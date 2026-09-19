import type { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '../../../src/server/http/respond';
import { decodeCursor } from '../../../src/server/http/cursor';
import { pageOf, parseLimit } from '../../../src/server/http/pagination';
import { requireUser } from '../../../src/server/auth/session';
import { listHistoryByUser } from '../../../src/server/db/repositories/anchors';
import { listActivePhotosByIds } from '../../../src/server/db/repositories/photos';
import { listRecentByAnchors } from '../../../src/server/db/repositories/generations';
import { toPhotoThumbDto } from '../../../src/server/domain/photoService';
import { toGenerationDto } from '../../../src/server/domain/generationService';
import type { Generation, HistoryItem, Photo } from '../../../src/shared/types';

/**
 * `GET /api/history`（`docs/prd/spec/03-接口契约.md` §3.6、`modules/M08-账号历史与彻底删除.md` §4）。
 * 只读、允许直连 repository；`cursor` 是不透明串，前端只回传不解析。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 每锚点最多返回的最近生成条数（`modules/M08` §4）。 */
const GENERATIONS_PER_ANCHOR = 10;

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

  const { rows: page, nextCursor } = pageOf(
    listHistoryByUser(user.id, {
      limit: limit + 1,
      cursorCreatedAt: cursor?.createdAt ?? null,
      cursorId: cursor?.id ?? null,
    }),
    limit,
    (anchor) => ({ createdAt: anchor.createdAt, id: anchor.id }),
  );

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

  // 一次取齐本页所有输入图与预处理图（SQL 的 EXISTS 已保证每锚点至少有一张未软删），避免 N+1。
  const preprocessedIds = page
    .map((anchor) => anchor.preprocessedPhotoId)
    .filter((id): id is number => id !== null);
  const inputIds = [...new Set([...page.flatMap((anchor) => anchor.inputPhotoIds), ...preprocessedIds])];
  const activePhotos = new Map(listActivePhotosByIds(user.id, inputIds).map((photo) => [photo.id, photo]));

  const items: HistoryItem[] = [];
  for (const anchor of page) {
    let source: Photo | undefined;
    for (const id of anchor.inputPhotoIds) {
      const photo = activePhotos.get(id);
      if (photo !== undefined) {
        source = toPhotoThumbDto(photo);
        break;
      }
    }
    if (source === undefined) continue; // SQL 的 EXISTS 已保证，这里只是兜底
    const preprocessed =
      anchor.preprocessedPhotoId === null ? null : activePhotos.get(anchor.preprocessedPhotoId);
    items.push({
      anchorId: anchor.id,
      anchorText: anchor.anchorText ?? '',
      confirmedAt: anchor.confirmedAt,
      sourcePhoto: source,
      preprocessedPhoto: preprocessed === null || preprocessed === undefined ? null : toPhotoThumbDto(preprocessed),
      generations: withThumbGenerations(byAnchor.get(anchor.id) ?? []),
    });
  }

  return ok({ items, nextCursor });
});
