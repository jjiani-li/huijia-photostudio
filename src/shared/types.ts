/**
 * 前后端唯一共享的类型层（`app/` 与 `src/server/` 都可 import；本文件不允许 import 任何 `src/server/` 下的东西）。
 * 形状以 `docs/prd/spec/03-接口契约.md` §4–§5 为准；错误码清单见 §5 错误码总表。
 */
import { z } from 'zod';

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_PARAM',
  'INVALID_FILE_TYPE',
  'FILE_TOO_LARGE',
  'CODE_INVALID',
  'CODE_EXPIRED',
  'CODE_RATE_LIMITED',
  'CONSENT_REQUIRED',
  'ANCHOR_NOT_FOUND',
  'ANCHOR_NOT_CONFIRMED',
  'ANCHOR_LOW_QUALITY',
  'REALNAME_REQUIRED',
  'GENERATION_IN_PROGRESS',
  'QUOTA_EXCEEDED',
  'CONTENT_REJECTED',
  'PROVIDER_ERROR',
  'PROVIDER_TIMEOUT',
  'STORAGE_ERROR',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** ISO-8601 UTC 字符串，如 `2026-09-17T15:07:42.000Z` */
export type Iso = string;

/** 错误响应的统一 envelope（`docs/prd/spec/03-接口契约.md` §1.3）；成功响应不用 envelope。 */
export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

// ── 领域形状与 zod schema（`docs/prd/spec/03-接口契约.md` §4；API-02 的唯一来源）────────────

export type PhotoKind = 'original' | 'preprocessed' | 'generated';

/** 质量评分（仅 `kind='preprocessed'` 的非空 `quality_json` 落这个形状，`spec/03` §4）。 */
export interface Quality {
  usable: boolean;
  faceDetected: boolean;
  faceCount: number;
  sharpness: number;
  readability: number;
  damageLevel: number;
  warnings: string[];
  advice: string | null;
}

export interface Photo {
  id: number;
  kind: PhotoKind;
  url: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  createdAt: Iso;
}

export interface PhotoList {
  items: Photo[];
  nextCursor: string | null;
}

/** `content_reviews.verdict` 的取值域（`spec/03` §4、`spec/06` §5.6）。 */
export type ModerationVerdict = 'pass' | 'review' | 'reject';

export const photoSchema = z.object({
  id: z.number().int(),
  kind: z.enum(['original', 'preprocessed', 'generated']),
  url: z.string(),
  mime: z.string(),
  bytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  sha256: z.string(),
  createdAt: z.string(),
});

export const photoListSchema = z.object({
  items: z.array(photoSchema),
  nextCursor: z.string().nullable(),
});

export const qualitySchema = z.object({
  usable: z.boolean(),
  faceDetected: z.boolean(),
  faceCount: z.number().int(),
  sharpness: z.number(),
  readability: z.number(),
  damageLevel: z.number(),
  warnings: z.array(z.string()),
  advice: z.string().nullable(),
});

export const moderationVerdictSchema = z.enum(['pass', 'review', 'reject']);
