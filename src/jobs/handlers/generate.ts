import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ArkUpstreamError, getArk, mapArkError } from '../../server/ark';
import { AppError, ERROR_MESSAGE, appError } from '../../server/domain/errors';
import { nowIso } from '../../server/domain/time';
import { getDb } from '../../server/db/connection';
import {
  claimForRun,
  findById,
  insertResult,
  requeueForRetry,
  updateStatus,
  type GenerationRecord,
  type GenerationStatus,
} from '../../server/db/repositories/generations';
import { findById as findAnchorById } from '../../server/db/repositories/anchors';
import { getEra } from '../../server/db/repositories/config';
import { findActivePhotoForUser, insertPhoto, softDeletePhoto } from '../../server/db/repositories/photos';
import { rollback } from '../../server/db/repositories/usage';
import { AIGC_MARKER, markGeneratedImage } from '../../server/images/mark';
import { probeImage } from '../../server/images/probe';
import { audit } from '../../server/security/audit';
import { eraReview } from '../../server/security/eraReview';
import { moderateResult } from '../../server/security/moderation';
import { buildKey, getStorage, type ImageExt } from '../../server/storage';
import { AUTO_RETRY_ERROR_CODES, isAutoRetryable } from '../settle';
import type { EraCheck, ErrorCode, ModerationVerdict } from '../../shared/types';

/**
 * `generations` 的 handler（`docs/prd/modules/M06-生成编排.md` §5.9）：
 * `claim → 读参考图 → 调上游生图 → 逐张立即转存（探宽高 → 写隐式标识 → 原子落盘 → 插行 → 审计）
 * → 同事务写终态 / 回滚额度 / 写 generation.finish`。
 *
 * - 转存的固定序列与隐式标识语义以 `docs/prd/spec/06-合规与风控.md` §3.3 为准；标识写入失败
 *   **不**置任务失败（§3.4）。
 * - **任何异常都在本文件内落终态**，绝不把 `AppError` 抛给 worker 主循环
 *   （`docs/prd/spec/04-技术基线与目录结构.md` §4.1）。
 * - 逐张失败（下载 / 落盘）只减少产出张数，不中止整条任务（`M06` §5.9 ③）。
 */

const CONTENT_LOG_LIMIT = 500;

/** `params_json.outputFormat` → 落库 `mime` 与 `storage_key` 扩展名。 */
const FORMAT_MIME: Record<'png' | 'jpeg', string> = { png: 'image/png', jpeg: 'image/jpeg' };
const FORMAT_EXT: Record<'png' | 'jpeg', ImageExt> = { png: 'png', jpeg: 'jpg' };

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ level, scope: 'worker', job: 'generate', msg, ...extra, at: nowIso() });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/**
 * 异常 → 落库用的错误码与是否瞬时（`M06` §5.8 的 `retryable` 列）。
 * 上游错误走 `mapArkError` 的唯一映射入口；`AppError` 取瞬时错误码集合（与 worker 的判据同一集合）。
 */
const toFailure = (err: unknown): { code: ErrorCode; raw: string; retryable: boolean } => {
  if (err instanceof AppError) {
    return { code: err.code, raw: err.message, retryable: AUTO_RETRY_ERROR_CODES.has(err.code) };
  }
  const mapped = mapArkError(err);
  return { code: mapped.code, raw: mapped.raw, retryable: mapped.retryable };
};

/** `reference_photo_ids` → Base64 data URI；照片行不存在（或文件读不到）即 `STORAGE_ERROR`（`M06` §5.9 ①）。 */
const buildReferenceImages = async (generation: GenerationRecord): Promise<string[]> => {
  const storage = getStorage();
  const images: string[] = [];
  for (const photoId of generation.referencePhotoIds) {
    const photo = findActivePhotoForUser(photoId, generation.userId);
    if (photo === null) {
      throw appError('STORAGE_ERROR', { photoId, reason: '参考图不存在或已删除' });
    }
    const buffer = await storage.read(photo.storageKey);
    images.push(`data:${photo.mime};base64,${buffer.toString('base64')}`);
  }
  return images;
};

/**
 * 上游 `data[].url` → 字节：`http(s)` 走 `fetch`（签名链 86400s，必须立即转存），
 * 否则按仓库根解析路径（mock 的 `fixtures/images/*` 走这条）。两者失败都按 `STORAGE_ERROR` 映射。
 */
const readUpstreamBytes = async (url: string, signal?: AbortSignal): Promise<Buffer> => {
  if (/^https?:\/\//i.test(url)) {
    let response: Response;
    try {
      response = await fetch(url, { signal });
    } catch (err) {
      throw new ArkUpstreamError({ kind: 'storage', message: `下载上游图失败：${describe(err)}` });
    }
    if (!response.ok) {
      throw new ArkUpstreamError({ kind: 'storage', message: `下载上游图失败：HTTP ${response.status}` });
    }
    return Buffer.from(await response.arrayBuffer());
  }
  try {
    return await fs.readFile(path.resolve(process.cwd(), url));
  } catch (err) {
    throw new ArkUpstreamError({ kind: 'storage', message: `读取回放文件失败：${describe(err)}` });
  }
};

interface Produced {
  photoId: number;
  ordinal: number;
  seed: number | null;
  /** 年代复核快照；复核失败留 `NULL`（软标注不阻断，`modules/M07` §5.3）。 */
  eraCheck: EraCheck | null;
  /** 年龄偏差（有符号；负 = 变年轻），不可计算留 `NULL`。 */
  ageDelta: number | null;
}

/**
 * 写终态 + `generation_results` + 额度回滚 + `generation.finish` 审计，**四件事同一事务**
 * （`M06` §5.3 / §5.6 / §5.9⑥）。额度日取**入队日**（`generations.created_at` 的 UTC 日期），跨天完成不打错行。
 */
const commitTerminal = (
  generation: GenerationRecord,
  produced: Produced[],
  errorCode: ErrorCode,
  errorMessage: string | null,
  startedAt: string,
): GenerationStatus => {
  const n = produced.length;
  const requested = generation.requestedCount;
  const status: GenerationStatus = n === requested ? 'succeeded' : n > 0 ? 'partial' : 'failed';
  const finishedAt = nowIso();
  const generationDay = generation.createdAt.slice(0, 10);
  getDb().transaction(() => {
    for (const row of produced) {
      insertResult({
        generationId: generation.id,
        photoId: row.photoId,
        ordinal: row.ordinal,
        seed: row.seed,
        eraCheck: row.eraCheck,
        ageDelta: row.ageDelta,
        createdAt: finishedAt,
      });
    }
    updateStatus({
      id: generation.id,
      status,
      attempt: generation.attempt,
      errorCode: status === 'succeeded' ? null : errorCode,
      errorMessage: status === 'succeeded' ? null : errorMessage,
      startedAt,
      finishedAt,
    });
    rollback(generation.userId, generationDay, requested - n);
    audit({ action: 'generation.finish', userId: generation.userId, target: `generation:${generation.id}` });
  })();
  return status;
};

/**
 * 单张的固定转存序列（`spec/06` §3.3）：下载 → 探宽高 → 写隐式标识 → 原子落盘 → 插 `photos`
 * → 写 `audit_logs(action='photo.mark')`。宽高一律取 `probeImage()` 的**实测值**，不得写请求的 `size`；
 * `photos.bytes` 取标识写入**之后**的长度（`E2E-06`）。
 */
const storeImage = async (
  generation: GenerationRecord,
  url: string,
  signal?: AbortSignal,
): Promise<{ photoId: number; bytes: Buffer }> => {
  const format = generation.params.outputFormat;
  const bytes = await readUpstreamBytes(url, signal);
  const probe = await probeImage(bytes);

  // 标识写入失败不阻断交付（`spec/06` §3.4）：记 `mode:'failed'` 审计行 + warn，照常落盘未标记文件。
  let marked = bytes;
  let implicit = false;
  let markFailure: string | null = null;
  try {
    const out = await markGeneratedImage(bytes, format);
    marked = out.marked;
    implicit = out.implicit;
  } catch (err) {
    markFailure = describe(err);
    log('warn', '隐式标识写入失败，交付未标记文件', {
      generationId: generation.id,
      format,
      reason: markFailure.slice(0, CONTENT_LOG_LIMIT),
    });
  }

  const key = buildKey(generation.userId, FORMAT_EXT[format]);
  await getStorage().save(key, marked);
  const photo = insertPhoto({
    userId: generation.userId,
    kind: 'generated',
    storageKey: key,
    mime: FORMAT_MIME[format],
    bytes: marked.length,
    width: probe.width,
    height: probe.height,
    sha256: sha256(marked),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  });

  // 服务端标识记录：无论是否真的写入了元数据都要写，`mode` 三态不可合并（`spec/06` §3.3）。
  const markMeta = implicit
    ? { implicit: true, format, marker: AIGC_MARKER }
    : markFailure === null
      ? { implicit: false, mode: 'off', format }
      : { implicit: false, mode: 'failed', format, reason: markFailure.slice(0, CONTENT_LOG_LIMIT) };
  audit({
    action: 'photo.mark',
    userId: generation.userId,
    target: `photo:${photo.id}`,
    meta: markMeta,
  });
  return { photoId: photo.id, bytes: marked };
};

/**
 * 撤销一张已转存的生成图（`modules/M07` §5.6）：内容审核判定为 `reject` 或审核失败时**软删**该
 * `kind='generated'` 行（磁盘文件由 `runPurge()` 清理），该张不计入产出 `n`。
 */
const discardStoredImage = (photoId: number): void => {
  softDeletePhoto(photoId, nowIso());
};

const toDataUri = (mime: string, bytes: Buffer): { mime: string; base64: string } => ({
  mime,
  base64: bytes.toString('base64'),
});

/**
 * 执行一个生成任务。`signal` 来自 worker 的 `JOB_TIMEOUT_SECONDS` 竞速（`spec/04` §4.6）。
 */
export const runGenerateJob = async (generation: GenerationRecord, signal?: AbortSignal): Promise<void> => {
  const startedAtMs = Date.now();
  const startedAt = nowIso();

  // claim：仅 `queued → running` 成功（`changes === 1`）才继续，否则放弃本轮（`spec/04` §4.6）。
  if (claimForRun(generation.id, startedAt) !== 1) {
    log('info', 'claim skipped', { generationId: generation.id, status: generation.status });
    return;
  }

  const produced: Produced[] = [];
  let lastFailure: { code: ErrorCode; raw: string; retryable: boolean } | null = null;

  /** 终态判定 + 回滚未产出额度 + `generation_results` + `generation.finish`（同一事务，`M06` §5.3）。 */
  const finalize = (): void => {
    const status = commitTerminal(
      generation,
      produced,
      lastFailure?.code ?? 'PROVIDER_ERROR',
      lastFailure?.raw ?? null,
      startedAt,
    );
    log('info', 'done', {
      generationId: generation.id,
      status,
      produced: produced.length,
      requested: generation.requestedCount,
      ms: Date.now() - startedAtMs,
    });
  };

  try {
    const images = await buildReferenceImages(generation);
    const result = await getArk().generateImage(
      {
        prompt: generation.prompt,
        images,
        size: generation.params.size,
        outputFormat: generation.params.outputFormat,
        watermark: generation.params.watermark,
        count: generation.requestedCount,
      },
      signal,
    );

    // 复核的上下文（`modules/M07` §5.2）：所选年代口径取 `eras.name` / `eras.constraint_pack`，
    // 年龄基准取 `identity_anchors.features_json.ageRange`（只用结构化字段，不解析 `anchor_text`，§5.4）。
    const era = getEra(generation.eraCode);
    const anchor = findAnchorById(generation.anchorId);

    // 逐张：转存 → 审核（硬闸门）→ 复核（软标注），`ordinal` 从 0 连续递增。固定顺序见 `modules/M07` §5.1：
    // 审核在前（`reject` 撤销该张及后续张的转存，越早发现代价越小），复核在后（失败只少一个标注）。
    for (const [index, item] of result.images.entries()) {
      let stored: { photoId: number; bytes: Buffer };
      try {
        stored = await storeImage(generation, item.url, signal);
      } catch (err) {
        // 单张转存失败只少一张，不中止整条任务（`modules/M06` §5.9 ③）。
        lastFailure = toFailure(err);
        log('warn', '转存失败，跳过该张', {
          generationId: generation.id,
          ordinal: index,
          code: lastFailure.code,
          reason: lastFailure.raw.slice(0, CONTENT_LOG_LIMIT),
        });
        continue;
      }

      // ② 审核在前，硬闸门（`modules/M07` §5.6）：`reject` → 撤销该张及后续张的转存。
      let verdict: ModerationVerdict;
      try {
        verdict = await moderateResult({
          userId: generation.userId,
          generationId: generation.id,
          image: toDataUri(FORMAT_MIME[generation.params.outputFormat], stored.bytes),
        });
      } catch (err) {
        // 审核失败（内部已重试 1 次）**不放过未审核的结果**：撤销该张、中止后续张，终态按 `n` 判定。
        lastFailure = toFailure(err);
        discardStoredImage(stored.photoId);
        log('warn', '审核失败，撤销该张并中止后续', {
          generationId: generation.id,
          ordinal: index,
          code: lastFailure.code,
          reason: lastFailure.raw.slice(0, CONTENT_LOG_LIMIT),
        });
        break;
      }
      if (verdict === 'reject') {
        lastFailure = { code: 'CONTENT_REJECTED', raw: ERROR_MESSAGE.CONTENT_REJECTED, retryable: false };
        discardStoredImage(stored.photoId);
        log('warn', '内容审核拒绝，撤销该张并中止后续', {
          generationId: generation.id,
          ordinal: index,
        });
        break;
      }

      // ③ 复核在后，软标注（`modules/M07` §5.1 ③）：失败留 `NULL` 并 warn，不占用撤销路径。
      let eraCheck: EraCheck | null = null;
      let ageDelta: number | null = null;
      try {
        const review = await eraReview({
          image: `data:${FORMAT_MIME[generation.params.outputFormat]};base64,${stored.bytes.toString('base64')}`,
          eraCode: generation.eraCode,
          sceneId: generation.sceneId,
          eraName: era?.name ?? generation.eraCode,
          constraintPack: era?.constraintPack ?? '',
          anchorAgeRange: anchor?.features?.ageRange ?? null,
        });
        eraCheck = review.eraCheck;
        ageDelta = review.ageDelta;
      } catch (err) {
        log('warn', '年代复核失败，留 NULL 继续', {
          generationId: generation.id,
          ordinal: index,
          reason: describe(err).slice(0, CONTENT_LOG_LIMIT),
        });
      }

      produced.push({ photoId: stored.photoId, ordinal: produced.length, seed: item.seed, eraCheck, ageDelta });
    }
  } catch (err) {
    lastFailure = toFailure(err);
    log('warn', 'generate failed', {
      generationId: generation.id,
      code: lastFailure.code,
      produced: produced.length,
      reason: lastFailure.raw.slice(0, CONTENT_LOG_LIMIT),
      ms: Date.now() - startedAtMs,
    });
  }

  // 零产出 + 瞬时错误 + `attempt < 1` → 回 `queued`（`attempt + 1`），不回滚、不写终态与 finish 审计
  // （`spec/04` §4.6）。上游调用失败与「逐张转存全部失败」走同一判据——后者不会抛出到上面的 catch。
  if (
    produced.length === 0 &&
    lastFailure !== null &&
    lastFailure.retryable &&
    isAutoRetryable({ code: lastFailure.code, attempt: generation.attempt, produced: 0 })
  ) {
    requeueForRetry(generation.id, generation.attempt + 1, lastFailure.code, lastFailure.raw);
    log('warn', 'auto retry scheduled', {
      generationId: generation.id,
      attempt: generation.attempt + 1,
      code: lastFailure.code,
      reason: lastFailure.raw.slice(0, CONTENT_LOG_LIMIT),
    });
    return;
  }

  try {
    finalize();
  } catch (err) {
    log('error', '终态落库失败', { generationId: generation.id, error: describe(err) });
  }
};

/**
 * `JOB_TIMEOUT_SECONDS` 兜底（`spec/04-技术基线与目录结构.md` §4.6）：worker 到点 abort 后由
 * `registry` 调用。**只对仍处 `running` 的行生效**——handler 可能已自行落终态，无条件重写会覆盖结果；
 * 失败态必须连同额度回滚与 `generation.finish` 审计，故不能走通用的 `settleJobFailure`。
 */
export const failTimedOutGeneration = (id: number): void => {
  const record = findById(id);
  if (record === null || record.status !== 'running') return;
  if (isAutoRetryable({ code: 'PROVIDER_TIMEOUT', attempt: record.attempt, produced: 0 })) {
    requeueForRetry(id, record.attempt + 1, 'PROVIDER_TIMEOUT', ERROR_MESSAGE.PROVIDER_TIMEOUT);
    return;
  }
  commitTerminal(record, [], 'PROVIDER_TIMEOUT', ERROR_MESSAGE.PROVIDER_TIMEOUT, record.startedAt ?? nowIso());
};
