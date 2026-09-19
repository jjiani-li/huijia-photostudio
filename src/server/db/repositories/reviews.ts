import { getDb } from '../connection';
import type { Iso } from '../../../shared/types';

/**
 * `content_reviews` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.13）。
 * `stage` / `verdict` 的取值域以 `spec/01` §3.13 为准；审核判定归 `tickets/T11`。
 */
export type ReviewStage = 'upload' | 'prompt' | 'result';
export type ReviewVerdict = 'pass' | 'reject' | 'review';

export interface ContentReviewRecord {
  id: number;
  userId: number;
  stage: ReviewStage;
  targetType: string;
  targetId: number;
  verdict: ReviewVerdict;
  reason: string | null;
  model: string | null;
  createdAt: Iso;
}

interface ContentReviewRow {
  id: number;
  user_id: number;
  stage: ReviewStage;
  target_type: string;
  target_id: number;
  verdict: ReviewVerdict;
  reason: string | null;
  model: string | null;
  created_at: string;
}

const COLUMNS = 'id, user_id, stage, target_type, target_id, verdict, reason, model, created_at';

const toReview = (row: ContentReviewRow): ContentReviewRecord => ({
  id: row.id,
  userId: row.user_id,
  stage: row.stage,
  targetType: row.target_type,
  targetId: row.target_id,
  verdict: row.verdict,
  reason: row.reason,
  model: row.model,
  createdAt: row.created_at,
});

export interface NewContentReview {
  userId: number;
  stage: ReviewStage;
  targetType: string;
  targetId: number;
  verdict: ReviewVerdict;
  reason: string | null;
  model: string | null;
  createdAt: Iso;
}

export const insertContentReview = (input: NewContentReview): ContentReviewRecord => {
  const db = getDb();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO content_reviews (user_id, stage, target_type, target_id, verdict, reason, model, created_at)
         VALUES (@userId, @stage, @targetType, @targetId, @verdict, @reason, @model, @createdAt)`,
      )
      .run(input);
    const row = db
      .prepare(`SELECT ${COLUMNS} FROM content_reviews WHERE id = ?`)
      .get(info.lastInsertRowid) as ContentReviewRow | undefined;
    if (row === undefined) throw new Error('content_reviews 插入后读回失败');
    return toReview(row);
  })();
};

export const listByTarget = (targetType: string, targetId: number): ContentReviewRecord[] =>
  (
    getDb()
      .prepare(
        `SELECT ${COLUMNS} FROM content_reviews WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC`,
      )
      .all(targetType, targetId) as ContentReviewRow[]
  ).map(toReview);
