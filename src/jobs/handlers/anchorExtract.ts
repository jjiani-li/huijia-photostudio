import { z } from 'zod';
import { getArk, mapArkError } from '../../server/ark';
import { AppError, ERROR_MESSAGE, appError } from '../../server/domain/errors';
import { ANCHOR_MAX_IMAGES, preprocessPhoto } from '../../server/domain/anchorService';
import { nowIso } from '../../server/domain/time';
import {
  claimForRun,
  findById,
  markFailed,
  markSucceeded,
  type AnchorRecord,
} from '../../server/db/repositories/anchors';
import {
  findActivePhotoForUser,
  findPreprocessedBySource,
  updateQualityJson,
  type PhotoRecord,
} from '../../server/db/repositories/photos';
import { buildAnalysisInput, normalize } from '../../server/images/preprocess';
import { scoreQuality } from '../../server/images/quality';
import { ANCHOR_PROMPTS } from '../../server/prompt/versions';
import { getStorage } from '../../server/storage';
import { anchorFeaturesSchema, type AnchorFeatures, type ErrorCode, type Quality } from '../../shared/types';

/**
 * `identity_anchors` 的提取 handler（`docs/prd/modules/M03-身份锚点提取.md` §5.3）。
 * 契约：`claim → 质量前置 → 送图 → 调上游 → 容错解析 → 写终态`；**任何异常都在本文件内落终态**，
 * 绝不把 `AppError` 抛给 worker 主循环（`docs/prd/spec/04-技术基线与目录结构.md` §4.6）。
 */

/** §7 代码内常量：可用性判定的清晰度下界（数值依据见 §9 第 1 条）。 */
export const ANCHOR_MIN_READABILITY = 0.35;

/** §5.5 第 4 步的长度窗口：与 prompt 里的要求同一区间（`E2E-02`）。 */
export const ANCHOR_MIN_LENGTH = 60;
export const ANCHOR_MAX_LENGTH = 120;

/** §5.5 第 5、6 步的词表（`anchor_text` 会原样进【身份锚点】段，命中即落 `PROVIDER_ERROR`）。 */
const NEGATION_RE = /不要|禁止|no\s|without/i;
const BEAUTIFY_RE = /慈祥|有气质|精神矍铄|面容温和|和蔼|儒雅|端庄|保养得好|显得年轻/i;

/** 日志里附上游返回体时的截断长度（§5.3 步骤 5）。 */
const CONTENT_LOG_LIMIT = 500;

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ level, scope: 'worker', job: 'anchorExtract', msg, ...extra, at: nowIso() });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** §5.5 第 1 步：剥 ```json 包裹。 */
export const stripFence = (raw: string): string =>
  raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

export type AnchorParse =
  | { ok: true; anchorText: string; features: AnchorFeatures }
  | { ok: false; reason: string };

/** §5.5 第 3 步：`anchor` 非空字符串 + `features` 恰 12 键（多余键被 `.strip()` 丢弃）。 */
const anchorResponseSchema = z.object({
  anchor: z.string().min(1),
  features: anchorFeaturesSchema,
});

/**
 * §5.5 的六步容错解析，**按顺序执行、任一步失败都返回失败**（调用方一律落 `PROVIDER_ERROR`）：
 * 剥包裹 → 反序列化 → zod 12 键 → 长度 60–120 字符 → 否定词拦截 → 美化词拦截。
 *
 * 输入是「上游正文原文」`AnchorExtractResult.raw`（`modules/M03-身份锚点提取.md` §5.3 步骤 4）；
 * provider（real / mock）只负责取回正文，六步逻辑只有这一份、且每一步都可被单元测试直接覆盖。
 */
export const parseAnchorResponse = (raw: string): AnchorParse => {
  // ① 剥包裹
  const text = stripFence(raw);

  // ② 反序列化：必须是对象
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'JSON.parse 失败' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: '返回体不是 JSON 对象' };
  }

  // ③ 结构校验：12 键缺一不可、每键非空字符串；多余键被 strip 丢弃
  const schema = anchorResponseSchema.safeParse(parsed);
  if (!schema.success) {
    return { ok: false, reason: `结构校验失败：${schema.error.issues.map((i) => i.path.join('.')).join(',')}` };
  }
  const { anchor, features } = schema.data;

  // ④ 长度窗口（单位：字符）
  if (anchor.length < ANCHOR_MIN_LENGTH || anchor.length > ANCHOR_MAX_LENGTH) {
    return { ok: false, reason: `anchor 长度 ${anchor.length} 越出 ${ANCHOR_MIN_LENGTH}-${ANCHOR_MAX_LENGTH}` };
  }

  // ⑤ 否定词拦截（会让 PR-03 变红）
  if (NEGATION_RE.test(anchor)) return { ok: false, reason: 'anchor 命中否定词' };

  // ⑥ 美化词拦截（会让 PR-04 的年龄痕迹失效）
  if (BEAUTIFY_RE.test(anchor)) return { ok: false, reason: 'anchor 命中美化词' };

  return { ok: true, anchorText: anchor, features };
};

/** §6.1：任一条件命中即终止提取（`quality` 快照同时落库）。 */
export const isLowQuality = (quality: Quality): boolean =>
  quality.usable === false ||
  quality.faceDetected === false ||
  quality.faceCount === 0 ||
  quality.faceCount > 1 ||
  quality.readability < ANCHOR_MIN_READABILITY;

/** `photos.quality_json` 为空时补算一次并回写（§3：本环节只读已有值）。 */
const ensureQuality = async (photo: PhotoRecord): Promise<Quality> => {
  if (photo.qualityJson !== null) return photo.qualityJson;
  const buffer = await getStorage().read(photo.storageKey);
  const normalized = await normalize(buffer);
  const quality = scoreQuality(
    await buildAnalysisInput(normalized.buffer, normalized.width, normalized.height, normalized.resized),
  );
  updateQualityJson(photo.id, quality);
  return quality;
};

/**
 * §5.3 步骤 3：按 `input_photo_ids` 顺序取预处理派生图；找不到就补做一张再落库。
 * 主图优先用 `preprocessed_photo_id`（它就是 `input_photo_ids` 首张的派生图）。
 */
const resolveImages = async (userId: number, anchor: AnchorRecord): Promise<PhotoRecord[]> => {
  const main =
    anchor.preprocessedPhotoId === null
      ? null
      : findActivePhotoForUser(anchor.preprocessedPhotoId, userId);
  const out: PhotoRecord[] = [];
  for (const photoId of anchor.inputPhotoIds) {
    const source = findActivePhotoForUser(photoId, userId);
    if (source === null) throw appError('INTERNAL', { reason: `输入照片 ${photoId} 不存在或已删除` });
    if (source.kind === 'preprocessed') {
      out.push(source);
      continue;
    }
    if (source.kind === 'generated') {
      throw appError('INTERNAL', { reason: `输入照片 ${photoId} 是 kind='generated'` });
    }
    const derived = main !== null && main.sourcePhotoId === photoId ? main : findPreprocessedBySource(photoId);
    out.push(derived ?? (await preprocessPhoto(userId, photoId)).photo);
  }
  return out;
};

/** 异常 → 落库用的错误码；上游错误走 `mapArkError` 的唯一映射入口。 */
const toFailure = (err: unknown): { code: ErrorCode; raw: string } => {
  if (err instanceof AppError) return { code: err.code, raw: err.message };
  const mapped = mapArkError(err);
  return { code: mapped.code, raw: mapped.raw };
};

export interface AnchorExtractJob {
  anchorId: number;
}

/**
 * worker handler 入口（§5.3）。`claim` 失败即返回；其余任何分支都写 `identity_anchors` 的终态。
 */
export const anchorExtractHandler = async (job: AnchorExtractJob): Promise<void> => {
  const startedAtMs = Date.now();
  const anchor = findById(job.anchorId);
  if (anchor === null) {
    log('warn', 'anchor not found', { anchorId: job.anchorId });
    return;
  }

  // ① claim：仅 `queued → running` 成功（`changes === 1`）才继续，否则直接放弃本轮（§3、§4.6）。
  if (claimForRun(anchor.id, nowIso()) !== 1) {
    log('info', 'claim skipped', { anchorId: anchor.id, status: anchor.status });
    return;
  }

  /** 失败落库；落库本身失败也只记日志，绝不抛出（worker 主循环必须活着）。 */
  const fail = (code: ErrorCode, quality: Quality | null): void => {
    try {
      markFailed({
        id: anchor.id,
        errorCode: code,
        errorMessage: ERROR_MESSAGE[code],
        quality,
        finishedAt: nowIso(),
      });
    } catch (err) {
      log('error', 'mark failed 落库失败', { anchorId: anchor.id, code, error: String(err) });
    }
  };

  const promptVersion = anchor.promptVersion;
  let imageCount = 0;

  try {
    // ② prompt 注册表：未注册是我方数据问题（发版事故），落 INTERNAL 且不调上游（§5.3 步骤 1）。
    const systemPrompt = ANCHOR_PROMPTS[promptVersion];
    if (systemPrompt === undefined) {
      log('error', 'prompt_version 未注册', { anchorId: anchor.id, promptVersion });
      fail('INTERNAL', null);
      return;
    }

    // ③ 质量前置判定（§6.1）：不过关就不浪费一次生成。
    if (anchor.preprocessedPhotoId === null) {
      log('error', '缺少 preprocessed_photo_id', { anchorId: anchor.id });
      fail('INTERNAL', null);
      return;
    }
    const main = findActivePhotoForUser(anchor.preprocessedPhotoId, anchor.userId);
    if (main === null) {
      log('error', 'preprocessed 照片不存在或已删除', { anchorId: anchor.id, photoId: anchor.preprocessedPhotoId });
      fail('INTERNAL', null);
      return;
    }
    const quality = await ensureQuality(main);
    if (isLowQuality(quality)) {
      log('warn', 'low quality', { anchorId: anchor.id, readability: quality.readability, faceCount: quality.faceCount });
      fail('ANCHOR_LOW_QUALITY', quality);
      return;
    }

    // ④ 组装送图清单：顺序等于 input_photo_ids（§5.4），N ≤ ANCHOR_MAX_IMAGES。
    const photos = await resolveImages(anchor.userId, anchor);
    imageCount = photos.length;
    if (imageCount === 0 || imageCount > ANCHOR_MAX_IMAGES) {
      log('error', '送图清单数量非法', { anchorId: anchor.id, imageCount });
      fail('INTERNAL', quality);
      return;
    }
    const images = await Promise.all(
      photos.map(async (photo) => ({
        mime: photo.mime,
        base64: (await getStorage().read(photo.storageKey)).toString('base64'),
      })),
    );

    // ⑤ 调用读图 + 六步容错解析。provider 只回正文原文，解析全在本处（§5.3 步骤 4、§5.5）。
    const result = await getArk().extractAnchor({ images, systemPrompt });
    const parsed = parseAnchorResponse(result.raw);
    if (!parsed.ok) {
      log('warn', 'anchor 解析不合格', {
        anchorId: anchor.id,
        reason: parsed.reason,
        content: result.raw.slice(0, CONTENT_LOG_LIMIT),
      });
      fail('PROVIDER_ERROR', quality);
      return;
    }

    // ⑥ 成功落库：`anchor_text` / `features_json` 非空，`features` 恰 12 键。
    markSucceeded({
      id: anchor.id,
      anchorText: parsed.anchorText,
      features: parsed.features,
      quality,
      // 主图在创建行时已选定，本处不覆写用户传入的 `preprocessed_photo_id`（`modules/M03` §3）。
      preprocessedPhotoId: anchor.preprocessedPhotoId,
      finishedAt: nowIso(),
    });
    log('info', 'done', {
      anchorId: anchor.id,
      promptVersion,
      imageCount,
      ms: Date.now() - startedAtMs,
    });
  } catch (err) {
    const { code, raw } = toFailure(err);
    log('warn', 'anchor extract failed', {
      anchorId: anchor.id,
      promptVersion,
      imageCount,
      code,
      reason: raw.slice(0, CONTENT_LOG_LIMIT),
      ms: Date.now() - startedAtMs,
    });
    fail(code, null);
  }
};
