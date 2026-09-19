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

/** 结构化面部特征（12 键，`spec/03-接口契约.md` §4；也称身份锚点特征）。 */
export interface AnchorFeatures {
  gender: string;
  ageRange: string;
  hair: string;
  faceShape: string;
  forehead: string;
  eyebrows: string;
  eyes: string;
  nose: string;
  mouth: string;
  skin: string;
  distinctive: string;
  build: string;
}

/**
 * 身份锚点（`docs/prd/spec/03-接口契约.md` §3.3 / §4）：既是提取任务的作业记录，也是确认后的锚点。
 * `status !== 'succeeded'` 时 `anchorText` / `features` 为 `null`；`failed` 时 `error` 非空。
 */
export interface Anchor {
  id: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  attempt: number;
  anchorText: string | null;
  features: AnchorFeatures | null;
  model: string;
  promptVersion: string;
  quality: Quality | null;
  confirmedByUser: boolean;
  confirmedAt: Iso | null;
  error: { code: string; message: string } | null;
  sourcePhotos: Photo[];
  preprocessedPhoto: Photo | null;
  createdAt: Iso;
  finishedAt: Iso | null;
}

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

/**
 * 两项授权范围（`docs/prd/modules/M04-身份确认与授权.md` §5.1）；
 * 与 `docs/prd/spec/01-领域模型与数据库.md` §3.11 的 `consents.scope` 取值一致。
 * 顺序即文案顺序（§10），缺任一项 → `400 INVALID_PARAM`。
 */
export const CONSENT_SCOPES = ['photo_usage', 'family_agreement'] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];
export const consentScopeSchema = z.enum(CONSENT_SCOPES);

/**
 * `features_json` 的 12 键边界校验（`docs/prd/modules/M03-身份锚点提取.md` §5.5 第 3 步）：
 * 键名固定、每键非空字符串，**多余键被 `.strip()` 丢弃**（解析照样成功、落库恰 12 键）；
 * 缺键或类型不符才失败。锚点落库（repository）与上游返回解析（handler）共用这一份。
 */
export const anchorFeaturesSchema = z
  .object({
    gender: z.string().min(1),
    ageRange: z.string().min(1),
    hair: z.string().min(1),
    faceShape: z.string().min(1),
    forehead: z.string().min(1),
    eyebrows: z.string().min(1),
    eyes: z.string().min(1),
    nose: z.string().min(1),
    mouth: z.string().min(1),
    skin: z.string().min(1),
    distinctive: z.string().min(1),
    build: z.string().min(1),
  })
  .strip();

const anchorErrorSchema = z.object({ code: z.string(), message: z.string() });

export const anchorSchema = z.object({
  id: z.number().int(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  attempt: z.number().int(),
  anchorText: z.string().nullable(),
  features: anchorFeaturesSchema.nullable(),
  model: z.string(),
  promptVersion: z.string(),
  quality: qualitySchema.nullable(),
  confirmedByUser: z.boolean(),
  confirmedAt: z.string().nullable(),
  error: anchorErrorSchema.nullable(),
  sourcePhotos: z.array(photoSchema),
  preprocessedPhoto: photoSchema.nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

// ── 配置资产 DTO（`docs/prd/spec/03-接口契约.md` §3.4、§4；`API-02` / `API-06` 的唯一来源）────────

/** 年代选项；**不含** `promptPack` / `constraintPack` / `styleJson` / `packVersion`（`API-06`）。 */
export interface EraOption {
  code: string;
  name: string;
  slug: string;
  isMono: boolean;
  caption: string;
  sampleUrl: string | null;
  sortOrder: number;
}

/** 场景选项；**不含** `spacePack` / `packVersion`（`API-06`）。 */
export interface SceneOption {
  id: number;
  code: string;
  name: string;
  slug: string;
  category: string | null;
  caption: string;
  coverUrl: string | null;
  sortOrder: number;
}

/** 组合档案；**不含** `promptOverride`（`API-06`）。 */
export interface EraSceneProfile {
  eraCode: string;
  sceneId: number;
  confidence: number;
  visualSignature: string;
  sampleUrl: string | null;
}

/** `GET /api/config/era-scene` 的响应体（`docs/prd/spec/03-接口契约.md` §3.4、§4）。 */
export interface EraSceneConfig {
  version: string;
  confidenceHintThreshold: number;
  realismAnchor: string;
  eras: EraOption[];
  scenes: SceneOption[];
  profiles: EraSceneProfile[];
}

export const eraOptionSchema = z.object({
  code: z.string(),
  name: z.string(),
  slug: z.string(),
  isMono: z.boolean(),
  caption: z.string(),
  sampleUrl: z.string().nullable(),
  sortOrder: z.number().int(),
});

export const sceneOptionSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  slug: z.string(),
  category: z.string().nullable(),
  caption: z.string(),
  coverUrl: z.string().nullable(),
  sortOrder: z.number().int(),
});

export const eraSceneProfileSchema = z.object({
  eraCode: z.string(),
  sceneId: z.number().int(),
  confidence: z.number(),
  visualSignature: z.string(),
  sampleUrl: z.string().nullable(),
});

export const eraSceneConfigSchema = z.object({
  version: z.string(),
  confidenceHintThreshold: z.number(),
  realismAnchor: z.string(),
  eras: z.array(eraOptionSchema),
  scenes: z.array(sceneOptionSchema),
  profiles: z.array(eraSceneProfileSchema),
});

// ── 生成 DTO（`docs/prd/spec/03-接口契约.md` §3.5、§4；E2E-04 / E2E-09 的形状来源）──────────

/**
 * 年代复核判定的取值域（`docs/prd/spec/06-合规与风控.md` §5.2、`modules/M07` §5）；
 * 与内容审核判定（`ModerationVerdict`）是**两个词**，不得混用（`CONTEXT.md` 的「复核与审核」）。
 */
export type EraCheckVerdict = 'pass' | 'review' | 'reject';

/** 结果图的年代复核快照（`generation_results.era_check_json`）：只标注不阻断（`ERA-01`）。 */
export interface EraCheck {
  passed: boolean;
  verdict: EraCheckVerdict;
  findings: Array<{ item: string; reason: string }>;
  model: string | null;
}

export interface GenerationResult {
  id: number;
  photoId: number;
  url: string;
  width: number | null;
  height: number | null;
  seed: number | null;
  eraCheck: EraCheck | null;
  ageDelta: number | null;
  realismScore: number | null;
  userFeedback: 1 | -1 | -2 | null;
}

export interface Generation {
  id: number;
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';
  eraCode: string;
  eraName: string;
  sceneId: number;
  sceneName: string;
  requestedCount: number;
  attempt: number;
  prompt: string;
  templateVersion: string;
  params: { size: string; outputFormat: 'png' | 'jpeg'; watermark: boolean; provider: 'mock' | 'real' };
  error: { code: string; message: string } | null;
  createdAt: Iso;
  finishedAt: Iso | null;
  results: GenerationResult[];
}

export const eraCheckVerdictSchema = z.enum(['pass', 'review', 'reject']);

export const eraCheckSchema = z.object({
  passed: z.boolean(),
  verdict: eraCheckVerdictSchema,
  findings: z.array(z.object({ item: z.string(), reason: z.string() })),
  model: z.string().nullable(),
});

export const generationResultSchema = z.object({
  id: z.number().int(),
  photoId: z.number().int(),
  url: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  seed: z.number().int().nullable(),
  eraCheck: eraCheckSchema.nullable(),
  ageDelta: z.number().int().nullable(),
  realismScore: z.number().nullable(),
  userFeedback: z.union([z.literal(1), z.literal(-1), z.literal(-2)]).nullable(),
});

export const generationSchema = z.object({
  id: z.number().int(),
  status: z.enum(['queued', 'running', 'succeeded', 'partial', 'failed']),
  eraCode: z.string(),
  eraName: z.string(),
  sceneId: z.number().int(),
  sceneName: z.string(),
  requestedCount: z.number().int(),
  attempt: z.number().int(),
  prompt: z.string(),
  templateVersion: z.string(),
  params: z.object({
    size: z.string(),
    outputFormat: z.enum(['png', 'jpeg']),
    watermark: z.boolean(),
    provider: z.enum(['mock', 'real']),
  }),
  error: anchorErrorSchema.nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  results: z.array(generationResultSchema),
});
