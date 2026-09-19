import * as anchors from '../db/repositories/anchors';
import { hasActiveScope } from '../db/repositories/consents';
import type { EraRecord, EraSceneProfileRecord, SceneRecord } from '../db/repositories/config';
import * as config from '../db/repositories/config';
import * as generations from '../db/repositories/generations';
import * as usage from '../db/repositories/usage';
import * as users from '../db/repositories/users';
import type { GenerationRecord, InsertGenerationInput } from '../db/repositories/generations';
import { getDb } from '../db/connection';
import { arkImageModel } from '../ark';
import { buildPrompt } from '../prompt/build';
import { audit } from '../security/audit';
import { assertQuotaAvailable } from '../security/quota';
import { dayKey, nowIso } from './time';
import { appError, ERROR_MESSAGE } from './errors';
import type { ErrorCode, Generation } from '../../shared/types';

/**
 * `POST /api/generations` 前置校验里归本模块的两步（`docs/prd/modules/M04-身份确认与授权.md` §5.3）：
 * ① 锚点可用性（`status='succeeded'` 且 `confirmed_by_user=1`）→ `409 ANCHOR_NOT_CONFIRMED`（**先**）；
 * ② `photo_usage` 存在未吊销授权 → `403 CONSENT_REQUIRED`（**后**）。顺序固定，
 * `SEC-01` 因此不依赖测试数据里是否存在 `consents` 行；锚点归属先于权限——不存在 / 他人
 * → `404 ANCHOR_NOT_FOUND`（不返回 403，`API-04`）。
 *
 * 完整的 8 步序列（实名 / `count` / era-scene / 额度 / 非终态）与单事务入队在同文件的
 * `createGeneration` 里，本函数就是其中第 4–6 步（`modules/M06-生成编排.md` §5.1）。
 */
export const assertAnchorGeneratable = (userId: number, anchorId: number): void => {
  const anchor = anchors.findByIdForUser(userId, anchorId);
  if (anchor === null) throw appError('ANCHOR_NOT_FOUND');
  if (anchor.status !== 'succeeded' || anchor.confirmedByUser !== 1) {
    throw appError('ANCHOR_NOT_CONFIRMED');
  }
  if (!hasActiveScope(userId, 'photo_usage')) throw appError('CONSENT_REQUIRED');
};

// ── createGeneration / retryGeneration：8 步序列 + 单事务入队（`modules/M06` §5.1–§5.2、§5.7）──

/** `count` 的取值域（`spec/03-接口契约.md` §3.5）；缺省 2 由 route handler 的 zod 兜住。 */
export const GENERATION_COUNTS = [2, 3, 4] as const;

export interface CreateGenerationInput {
  userId: number;
  anchorId: number;
  eraCode: string;
  sceneId: number;
  count: number;
}

/** 落库的拼装字段与 `generations` 行字段的合并（`insert` 的入参形状）。 */
const insertDraft = (
  input: CreateGenerationInput,
  draft: GenerationDraft,
  profileId: number | null,
  referencePhotoIds: number[],
): InsertGenerationInput => ({
  userId: input.userId,
  anchorId: input.anchorId,
  eraCode: input.eraCode,
  sceneId: input.sceneId,
  profileId,
  referencePhotoIds,
  prompt: draft.prompt,
  promptHash: draft.promptHash,
  templateVersion: draft.templateVersion,
  eraPackVersion: draft.eraPackVersion,
  scenePackVersion: draft.scenePackVersion,
  model: draft.model,
  params: draft.params,
  requestedCount: input.count,
  status: 'queued',
  attempt: 0,
  createdAt: nowIso(),
});

/**
 * `POST /api/generations` 的编排入口，**校验顺序即契约**（`spec/03-接口契约.md` §3.5、
 * `modules/M06-生成编排.md` §5.1）：
 *
 * - 第 1–7 步在事务**之外**先跑（快速失败、不产生写操作）；
 * - 第 8 步的排他检查在事务**内、`INSERT` 之前**执行（否则刚插入的 `queued` 行会把自己数进去，
 *   每次首次生成都误报 `GENERATION_IN_PROGRESS`）；
 * - 事务用 `db.transaction(...).immediate()`（`BEGIN IMMEDIATE`），与 `pnpm worker` 抢同一把写锁。
 */
export const createGeneration = (input: CreateGenerationInput): GenerationRecord => {
  // ① 实名门槛（最先，未实名时不进入后续校验、不产生任何写操作；`RN-01`）。
  if (users.findById(input.userId)?.verifiedAt === null) throw appError('REALNAME_REQUIRED');

  // ② 张数取值域。
  if (!(GENERATION_COUNTS as readonly number[]).includes(input.count)) throw appError('INVALID_PARAM');

  // ③ era / scene 必须存在且 is_active=1。
  const era = config.getEra(input.eraCode);
  const scene = config.getScene(input.sceneId);
  if (era === null || scene === null) throw appError('INVALID_PARAM');

  // ④⑤⑥ 锚点归属 → 可用性 → 授权（顺序固定在 assertAnchorGeneratable 内）。
  assertAnchorGeneratable(input.userId, input.anchorId);

  // ⑦ 额度预检（失败时不得留下 `generations` 行，`SEC-04`）。
  assertQuotaAvailable(input.userId, input.count);

  const anchor = anchors.findByIdForUser(input.userId, input.anchorId);
  if (anchor === null) throw appError('ANCHOR_NOT_FOUND');
  const profile = config.getProfile(input.eraCode, input.sceneId);
  const draft = buildGenerationDraft({
    anchorText: anchor.anchorText ?? '',
    era,
    scene,
    profile,
  });
  const referencePhotoIds = anchor.preprocessedPhotoId === null ? [] : [anchor.preprocessedPhotoId];
  const record = insertDraft(input, draft, profile?.id ?? null, referencePhotoIds);

  return getDb()
    .transaction(() => {
      // ① 排他复查（§5.1 第 8 步）。
      if (generations.checkActiveByUser(input.userId) > 0) throw appError('GENERATION_IN_PROGRESS');
      // ② 额度复查 + 预扣（`generations += 1`、`images += count`）。
      assertQuotaAvailable(input.userId, input.count);
      usage.deduct(input.userId, dayKey(), input.count);
      const inserted = generations.insert(record);
      // ③④ 审计（同一事务，与业务写入一起提交）。
      audit({ action: 'generation.create', userId: input.userId, target: `generation:${inserted.id}` });
      return inserted;
    })
    .immediate();
};

/**
 * `POST /api/generations/:id/retry`（`modules/M06` §5.7）：允许的原任务状态为
 * `succeeded` / `partial` / `failed`；语义是**新建 `generations` 行**，不更新旧行（`E2E-09`）。
 * prompt 由 `createGeneration` **重新拼装**（配置包可能已升级），不复制旧行。
 */
export const retryGeneration = (input: { userId: number; generationId: number }): GenerationRecord => {
  const existing = generations.findByIdForUser(input.userId, input.generationId);
  if (existing === null) throw appError('NOT_FOUND');
  if (existing.status === 'queued' || existing.status === 'running') {
    throw appError('GENERATION_IN_PROGRESS');
  }
  return createGeneration({
    userId: input.userId,
    anchorId: existing.anchorId,
    eraCode: existing.eraCode,
    sceneId: existing.sceneId,
    count: existing.requestedCount,
  });
};

/**
 * `error` 一律取 `spec/03-接口契约.md` §5 的用户可见文案：库里的 `error_message` 是上游原文
 * （仅落库排查用），**绝不透给用户**（`spec/04-技术基线与目录结构.md` §4.1）。
 */
const toGenerationError = (code: string | null): Generation['error'] =>
  code === null
    ? null
    : { code, message: ERROR_MESSAGE[code as ErrorCode] ?? ERROR_MESSAGE.INTERNAL };

const toResultDto = (record: generations.GenerationResultRecord): Generation['results'][number] => ({
  id: record.id,
  photoId: record.photoId,
  url: `/api/photos/${record.photoId}/file`,
  width: record.width,
  height: record.height,
  seed: record.seed,
  eraCheck: record.eraCheck,
  ageDelta: record.ageDelta,
  realismScore: record.realismScore,
  userFeedback:
    record.userFeedback === 1 || record.userFeedback === -1 || record.userFeedback === -2
      ? record.userFeedback
      : null,
});

/**
 * `GenerationRecord` → `Generation` DTO（`spec/03-接口契约.md` §4）：`eraName` / `sceneName`
 * 由 `config` repository 读出后在此组装（不落库）；`results` 的 `url` 一律指 `/api/photos/:id/file`。
 */
export const toGenerationDto = (record: GenerationRecord): Generation => ({
  id: record.id,
  status: record.status,
  eraCode: record.eraCode,
  eraName: config.getEra(record.eraCode)?.name ?? record.eraCode,
  sceneId: record.sceneId,
  sceneName: config.getScene(record.sceneId)?.name ?? String(record.sceneId),
  requestedCount: record.requestedCount,
  attempt: record.attempt,
  prompt: record.prompt,
  templateVersion: record.templateVersion,
  params: record.params as Generation['params'],
  error: toGenerationError(record.errorCode),
  createdAt: record.createdAt,
  finishedAt: record.finishedAt,
  results: generations.listResultsByGeneration(record.id).map(toResultDto),
});

/** `GET /api/generations/:id`（`spec/03-接口契约.md` §3.5）：不是自己的资源一律 `404 NOT_FOUND`。 */
export const readGenerationForUser = (userId: number, id: number): Generation => {
  const record = generations.findByIdForUser(userId, id);
  if (record === null) throw appError('NOT_FOUND');
  return toGenerationDto(record);
};

// ── 拼装产物：`default_size` → `params_json.size` 与 prompt 落库字段（`modules/M05` §5.2、§5.3）────

/** `eras.default_size` 的总像素下限（`docs/prd/README.md` §4.1：低于即上游 `InvalidParameter`）。 */
export const MIN_SIZE_PIXELS = 3_686_400;
/** 总像素上限与宽高比取值域（同一处产品常数）。 */
export const MAX_SIZE_PIXELS = 16_777_216;
export const SIZE_ASPECT_MIN = 1 / 16;
export const SIZE_ASPECT_MAX = 16;

export interface GenerationParams {
  size: string;
  outputFormat: 'png';
  watermark: boolean;
  provider: 'mock' | 'real';
}

/** 写入 `generations` 的「拼装产物」列（`modules/M05` §3 的写表）。 */
export interface GenerationDraft {
  prompt: string;
  promptHash: string;
  templateVersion: string;
  eraPackVersion: string;
  scenePackVersion: string;
  model: string;
  params: GenerationParams;
}

/**
 * `size` 校验（`modules/M05` §5.2 第 1–2 步）：解析 `"2048x2048"`，校验总像素与宽高比。
 * 失败即内部拼装 bug，与上游 `InvalidParameter` 一致映射为 `INTERNAL`（`spec/03-接口契约.md` §5.1），
 * 是 `tickets/T09` 在写 `generations` 之前的 fail-fast 守卫。
 */
export const assertSizeAllowed = (size: string): void => {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (match === null) throw appError('INTERNAL');
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const aspect = width / height;
  if (pixels < MIN_SIZE_PIXELS || pixels > MAX_SIZE_PIXELS) throw appError('INTERNAL');
  if (aspect < SIZE_ASPECT_MIN || aspect > SIZE_ASPECT_MAX) throw appError('INTERNAL');
};

/**
 * 把已查好的 `anchorText` / `era` / `scene` / `profile` 组装成待落库的拼装产物
 * （`modules/M05` §5.1–§5.3）：调 `buildPrompt` 的唯一入口，取 `era.packVersion` / `scene.packVersion`，
 * 并解析 `params_json` 的四项。`anchorText` 为空（`succeeded` 但无文本的不变量被破坏）→ `ANCHOR_NOT_CONFIRMED`
 * （`modules/M05` §6）。`tickets/T09` 的 `createGeneration` 在单事务内调用本函数。
 */
export const buildGenerationDraft = (input: {
  anchorText: string;
  era: EraRecord;
  scene: SceneRecord;
  profile: EraSceneProfileRecord | null;
}): GenerationDraft => {
  if (input.anchorText.trim() === '') throw appError('ANCHOR_NOT_CONFIRMED');
  assertSizeAllowed(input.era.defaultSize);
  const built = buildPrompt(input);
  return {
    prompt: built.prompt,
    promptHash: built.promptHash,
    templateVersion: built.templateVersion,
    eraPackVersion: input.era.packVersion,
    scenePackVersion: input.scene.packVersion,
    model: arkImageModel(),
    params: {
      size: input.era.defaultSize,
      outputFormat: 'png',
      watermark: (process.env.WATERMARK_DEFAULT ?? 'false') === 'true',
      provider: process.env.PROVIDER === 'real' ? 'real' : 'mock',
    },
  };
};
