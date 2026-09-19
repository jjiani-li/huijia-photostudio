/**
 * 上传页的纯逻辑（`docs/prd/pages/P01-上传与身份确认.md` §4.2、§7）：多选取数与基准图判定。
 * 不依赖 React / 网络 / 存储，可被 `pnpm test` 直接断言。
 */
import type { Quality } from './types';

/** 一次最多上传的张数（`spec/03-接口契约.md` §3.3 的 `photoIds` 上限，缺省基准取前 5 张）。 */
export const MAX_UPLOAD_FILES = 5;

/**
 * 选文件的结果（`pages/P01` §4.2「超过 5 张」）：按**选择顺序**取前 5 张上传，
 * 其余进 `overflow`——**不处理**并提示。这里**不读 `readability`**：它由
 * `POST /api/photos/:id/preprocess` 产出，选文件时不可得（`modules/M02-预处理与质量评分.md`）。
 */
export interface PickedFiles<T> {
  selected: readonly T[];
  overflow: readonly T[];
}

export const pickFiles = <T>(files: readonly T[]): PickedFiles<T> =>
  files.length <= MAX_UPLOAD_FILES
    ? { selected: files, overflow: [] }
    : { selected: files.slice(0, MAX_UPLOAD_FILES), overflow: files.slice(MAX_UPLOAD_FILES) };

/** 基准图判定的最小输入：`quality = null` 表示预处理未回，不参与比较。 */
export interface BaselineInput {
  /** `kind='original'` 的 `photos.id`（`photoIds` 用）。 */
  photoId: number;
  /** `POST /api/photos/:id/preprocess` 的产物；未回为 `null`。 */
  quality: Quality | null;
  /** `kind='preprocessed'` 的行 id（提交时作 `preprocessedPhotoId`）；未回为 `null`。 */
  preprocessedPhotoId: number | null;
}

/** `readability` 降序，同值按 `sharpness` 降序（`pages/P01` §4.2）。 */
const isBetter = (candidate: Quality, incumbent: Quality): boolean =>
  candidate.readability !== incumbent.readability
    ? candidate.readability > incumbent.readability
    : candidate.sharpness > incumbent.sharpness;

/**
 * 基准图（`pages/P01` §4.2、§7）：只在 `usable === true` 的照片里比较，
 * `readability` 降序、同值按 `sharpness` 降序取第一张；`usable === false` 一律排后
 * （它们不作默认基准），**全部不可用返回 `null`**。用户可手动改选——只改
 * `preprocessedPhotoId`，不重传。
 */
export const pickBaseline = <T extends BaselineInput>(cards: readonly T[]): T | null => {
  let best: T | null = null;
  let bestQuality: Quality | null = null;
  for (const card of cards) {
    const quality = card.quality;
    if (quality === null || !quality.usable) continue;
    if (bestQuality === null || isBetter(quality, bestQuality)) {
      best = card;
      bestQuality = quality;
    }
  }
  return best;
};
