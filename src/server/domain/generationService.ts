import { findByIdForUser } from '../db/repositories/anchors';
import { hasActiveScope } from '../db/repositories/consents';
import type { EraRecord, EraSceneProfileRecord, SceneRecord } from '../db/repositories/config';
import { arkImageModel } from '../ark';
import { buildPrompt } from '../prompt/build';
import { appError } from './errors';

/**
 * `POST /api/generations` 前置校验里归本模块的两步（`docs/prd/modules/M04-身份确认与授权.md` §5.3）：
 * ① 锚点可用性（`status='succeeded'` 且 `confirmed_by_user=1`）→ `409 ANCHOR_NOT_CONFIRMED`（**先**）；
 * ② `photo_usage` 存在未吊销授权 → `403 CONSENT_REQUIRED`（**后**）。顺序固定，
 * `SEC-01` 因此不依赖测试数据里是否存在 `consents` 行；锚点归属先于权限——不存在 / 他人
 * → `404 ANCHOR_NOT_FOUND`（不返回 403，`API-04`）。
 *
 * 完整的 8 步序列（实名 / `count` / era-scene / 额度 / 非终态）与单事务入队由 `tickets/T09`
 * 在同一文件补上，并在其 `createGeneration` 里调用本函数
 * （`modules/M06-生成编排.md` §5.1 第 4–6 步）。
 */
export const assertAnchorGeneratable = (userId: number, anchorId: number): void => {
  const anchor = findByIdForUser(userId, anchorId);
  if (anchor === null) throw appError('ANCHOR_NOT_FOUND');
  if (anchor.status !== 'succeeded' || anchor.confirmedByUser !== 1) {
    throw appError('ANCHOR_NOT_CONFIRMED');
  }
  if (!hasActiveScope(userId, 'photo_usage')) throw appError('CONSENT_REQUIRED');
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
