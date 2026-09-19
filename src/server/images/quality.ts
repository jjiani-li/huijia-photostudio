import type { Quality } from '../../shared/types';

/**
 * 质量评分（`docs/prd/modules/M02-预处理与质量评分.md` §4.1）：纯函数，只消费 `AnalysisInput`、
 * 不读库 / 不写盘 / 不看环境变量。评分常数是本模块的标定值，**不做成环境变量**（§7）。
 */

/** `sharp().stats()` 的返回形状（只声明本模块会读的键）。 */
export interface SharpStats {
  channels: Array<{ stdev: number }>;
  sharpness: number;
}

export interface AnalysisInput {
  /** 长边 ≤ 1024 的灰度原始像素（一字节一像素） */
  gray1024: Uint8Array;
  stats: SharpStats;
  /** `gray1024` 的 256 桶直方图 */
  histogram: number[];
  width: number;
  height: number;
  faceBox: { x: number; y: number; w: number; h: number } | null;
  faceDetected: boolean;
  faceCount: number;
  resized: boolean;
  degenerateFace: boolean;
}

/** 标定常数（实测表见 `docs/prd/tickets/T04-预处理与质量评分.md` 的 `## Comments`）。 */
export const SHARP_FLOOR = 0.5;
export const SHARP_CEIL = 3.0;
export const HF_REFERENCE = 20.0;
export const CENTER_FACE_FLOOR = 0.5;
export const FALLBACK_FACE_SIZE_SCORE = 0.6;
/** §6.2 第 6 条警告的清晰度上界。 */
const SHARPNESS_WARN_CEIL = 5.0;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const sum = (nums: number[]): number => nums.reduce((s, n) => s + n, 0);

export function scoreQuality(a: AnalysisInput): Quality {
  const L = a.stats.sharpness; // Laplacian 卷积标准差
  const sd = a.stats.channels[0]?.stdev ?? 0; // 亮度通道标准差
  const pixels = a.gray1024.length; // 灰度图一字节一像素
  const hi = sum(a.histogram.slice(250)) / pixels; // v >= 250 的占比
  const lo = sum(a.histogram.slice(0, 6)) / pixels; // v <= 5 的占比

  const sharpness = clamp01((L - SHARP_FLOOR) / (SHARP_CEIL - SHARP_FLOOR));
  const resScore = clamp01(Math.min(a.width, a.height) / 1000);
  const contrastScore = clamp01(sd / 64);
  const faceSizeScore =
    a.faceBox === null
      ? FALLBACK_FACE_SIZE_SCORE
      : clamp01(
          (Math.max(a.faceBox.w, a.faceBox.h) / Math.max(a.width, a.height) - 0.05) / (0.30 - 0.05),
        );
  const readability = 0.35 * resScore + 0.25 * contrastScore + 0.25 * sharpness + 0.15 * faceSizeScore;
  const tailScore = clamp01((hi + lo) / 0.08);
  const hfLoss = clamp01(1 - L / HF_REFERENCE);
  const damageLevel = 0.5 * tailScore + 0.5 * hfLoss;

  return {
    usable: judgeUsable(a, readability, damageLevel).usable,
    faceDetected: a.faceDetected,
    faceCount: a.faceCount,
    sharpness: round3(sharpness),
    readability: round3(readability),
    damageLevel: round3(damageLevel),
    warnings: buildWarnings(a, { L, readability, damageLevel }),
    advice: judgeUsable(a, readability, damageLevel).advice,
  };
}

/** §6.1：顺序即优先级，第一个命中的行决定 `usable` 与 `advice`。 */
function judgeUsable(
  a: AnalysisInput,
  readability: number,
  damageLevel: number,
): { usable: boolean; advice: string | null } {
  if (!a.faceDetected && a.faceCount === 0) {
    return { usable: false, advice: '照片里没找到人脸，换一张人物正脸、别太小的试试' };
  }
  if (readability < 0.35) {
    return { usable: false, advice: '这张照片太模糊或者太暗，人物特征看不清，建议换一张更清楚的' };
  }
  if (damageLevel > 0.6) {
    return { usable: false, advice: '这张照片褪色或者破损得比较厉害，可能认不准长相，建议换一张保存得更好的' };
  }
  if (Math.min(a.width, a.height) < 320) {
    return { usable: false, advice: '这张照片太小了，放不进面部细节，建议换一张大一点的' };
  }
  return { usable: true, advice: null };
}

/** §6.2：固定文案，按表序累计，不自由拼接。 */
function buildWarnings(
  a: AnalysisInput,
  m: { L: number; readability: number; damageLevel: number },
): string[] {
  const warnings: string[] = [];
  if (!a.resized) warnings.push('原图分辨率偏低，面部细节可能不足');
  if (a.faceCount >= 2) warnings.push(`照片里有 ${a.faceCount} 个人，系统会以画面中间那个人为准`);
  if (m.readability >= 0.35 && m.readability < 0.5) warnings.push('这张照片不算清楚，认特征可能会有点偏差');
  if (m.damageLevel > 0.4 && m.damageLevel <= 0.6) {
    warnings.push('照片有褪色或者小破损，已经按原样保留，没有修');
  }
  if (a.degenerateFace) warnings.push('本地没启用人脸检测，人脸判断是估算的');
  if (m.L >= SHARP_FLOOR && m.L < SHARPNESS_WARN_CEIL) warnings.push('照片有点糊，人物特征可能不够准');
  return warnings;
}
