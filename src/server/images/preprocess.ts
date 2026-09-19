import sharp from 'sharp';
import { appError } from '../domain/errors';
import { probeImage, toImageError } from './probe';
import { CENTER_FACE_FLOOR, type AnalysisInput } from './quality';

/**
 * 归一化流水线（`docs/prd/modules/M02-预处理与质量评分.md` §5.1–§5.2）：
 * 方向校正 → 色彩空间统一 → 尺寸归一（长边 1600，绝不放大）→ jpeg 编码；
 * **不做**任何修复 / 美化 / 超分 / 锐化（§1.3 禁令清单）。
 */
const LONG_EDGE = 1600;
const ANALYZE_EDGE = 1024;
const CENTER_FRACTION = 0.6;

export interface NormalizeResult {
  buffer: Buffer;
  width: number;
  height: number;
  resized: boolean;
}

/** 纯函数：不读库、不写盘、不看环境变量；测试直接喂 Buffer。 */
export async function normalize(input: Buffer): Promise<NormalizeResult> {
  // 用 probeImage 做解码校验并取原图宽高（失败分类与上传侧共用 M01 §6.4 的映射表）。
  const inputMeta = await probeImage(input);
  const long = Math.max(inputMeta.width ?? 0, inputMeta.height ?? 0);
  const resized = long >= LONG_EDGE;
  // 元数据剥离不需要额外一步：sharp 默认不保留元数据，禁止调用 .withMetadata() / .keepMetadata()。
  let buffer: Buffer;
  try {
    buffer = await sharp(input)
      .rotate()
      .pipelineColourspace('srgb16')
      .toColourspace('srgb')
      .resize({
        width: LONG_EDGE,
        height: LONG_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: 'lanczos3',
      })
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: false })
      .toBuffer();
  } catch (err) {
    throw toImageError(err); // 失败去向统一由 probe.ts 的映射入口决定（M01 §6.4）
  }
  const out = await probeImage(buffer);
  if (out.width === null || out.height === null) {
    throw appError('STORAGE_ERROR', { reason: '归一化输出缺少宽高' });
  }
  return { buffer, width: out.width, height: out.height, resized };
}

/** `gray1024` 的 256 桶直方图（本模块逐字节统计，不来自 sharp，§4.1）。 */
export const histogram256 = (gray: Uint8Array): number[] => {
  const buckets = new Array<number>(256).fill(0);
  for (const byte of gray) buckets[byte] = (buckets[byte] ?? 0) + 1;
  return buckets;
};

/** §4.2 退化人脸检测：中心 60% 区域的高频能量（复用 §4.1 的拉普拉斯统计）。 */
const centerSharpness = async (normalized: Buffer, width: number, height: number): Promise<number> => {
  const cw = Math.max(1, Math.round(width * CENTER_FRACTION));
  const ch = Math.max(1, Math.round(height * CENTER_FRACTION));
  const left = Math.round((width - cw) / 2);
  const top = Math.round((height - ch) / 2);
  const crop = await sharp(normalized).extract({ left, top, width: cw, height: ch }).jpeg().toBuffer();
  return (await sharp(crop).greyscale().stats()).sharpness;
};

/** 构造 `scoreQuality()` 的输入（§4.1、§4.2）。 */
export async function buildAnalysisInput(
  normalized: Buffer,
  width: number,
  height: number,
  resized: boolean,
): Promise<AnalysisInput> {
  const gray1024 = await sharp(normalized)
    .greyscale()
    .resize({ width: ANALYZE_EDGE, height: ANALYZE_EDGE, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer();
  const stats = await sharp(normalized).greyscale().stats();
  const centerL = await centerSharpness(normalized, width, height);
  const faceDetected = centerL >= CENTER_FACE_FLOOR;
  return {
    gray1024,
    stats,
    histogram: histogram256(gray1024),
    width,
    height,
    faceBox: null,
    faceDetected,
    faceCount: faceDetected ? 1 : 0,
    resized,
    degenerateFace: true,
  };
}
