import sharp from 'sharp';
import { AppError, appError } from '../domain/errors';

/**
 * 图片探测（`docs/prd/modules/M01-照片资产与存储.md` §6.4 的失败分类表——本模块是全项目**唯一**
 * 规定 `sharp` 失败去向的地方）：
 * - 容器可解析、读不到宽高 → 返回 `null` 宽高，**继续**；
 * - 解码器打不开文件 → `INVALID_FILE_TYPE`（400）；
 * - 其它 `sharp` 失败 → `STORAGE_ERROR`（500）。
 */
export interface ProbeResult {
  width: number | null;
  height: number | null;
  mime: string | null;
}

const FORMAT_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heif: 'image/heic',
  heic: 'image/heic',
};

/** 「无法识别的格式 / 解码器打不开 / 文件损坏」类错误 → `INVALID_FILE_TYPE`；其余 → `STORAGE_ERROR`。 */
const DECODE_ERROR_RE =
  /unsupported|unrecogniz|unable to (open|decode)|not a (valid|known)|invalid|corrupt|premature|truncated/i;

/** `sharp` 失败的唯一映射入口（`docs/prd/modules/M01-照片资产与存储.md` §6.4）：全项目只有这里决定去向。 */
export const toImageError = (err: unknown): AppError => {
  const reason = err instanceof Error ? err.message : String(err);
  return DECODE_ERROR_RE.test(reason)
    ? appError('INVALID_FILE_TYPE', { reason })
    : appError('STORAGE_ERROR', { reason });
};

export const probeImage = async (buffer: Buffer): Promise<ProbeResult> => {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (err) {
    throw toImageError(err);
  }
  return {
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    mime: metadata.format === undefined ? null : (FORMAT_MIME[metadata.format] ?? null),
  };
};
