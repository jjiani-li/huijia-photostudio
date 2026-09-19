import * as zlib from 'node:zlib';
import sharp from 'sharp';

/**
 * 隐式标识（`docs/prd/spec/06-合规与风控.md` §3.1–§3.2）——**全项目唯一产物**。
 *
 * 只在 `kind='generated'` 的输出上调用：PNG 手插 `tEXt` 块（关键字 `AIGC`），JPEG 写
 * `EXIF IFD0.ImageDescription` 与 `IFD3.UserComment`。写失败**不阻断交付**（§3.4）：由调用方
 * （`src/jobs/handlers/generate.ts`）记 `mode='failed'` 的审计行并照常交付未标记文件。
 *
 * 与 `modules/M02-预处理与质量评分.md` §5 的禁令不冲突：那条针对**输入归一化**路径（源图必须
 * 剥离 EXIF），本文件只作用于生成输出，方向相反、对象不同。
 */

/** 纯 ASCII（含中文会让 PNG `tEXt` 与 EXIF `UserComment` 的字节串语义产生歧义，`CMP-01` 无法逐字符比对）；模型名与 `ARK_IMAGE_MODEL` 默认值一致（`MARK-06`、`MARK-07`）。 */
export const AIGC_MARKER = 'AIGC:service=home-photo-studio;model=doubao-seedream-5-0-lite-260128;v=1';

/** PNG `tEXt` 块的关键字。 */
export const AIGC_TEXT_KEYWORD = 'AIGC';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** `length(4) + type(4) + CRC(4)`。 */
const CHUNK_OVERHEAD = 12;
const TEXT_TYPE = 'tEXt';
const IHDR_TYPE = 'IHDR';

/**
 * `zlib.crc32` 可用（Node ≥ 20.15 / 22）则直接用，否则查表实现（PNG 规范 §5.5，
 * 多项式 `0xEDB88320`）；两条路径都返回同一位宽的无符号 32 位值。
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const tableCrc32 = (buf: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const nativeCrc32 = (): ((data: Buffer) => number) | null =>
  typeof zlib.crc32 === 'function' ? (data) => zlib.crc32(data) >>> 0 : null;

const crc32 = (buf: Buffer): number => (nativeCrc32() ?? tableCrc32)(buf);

interface PngChunk {
  type: string;
  /** chunk 数据段（不含 length / type / CRC）。 */
  data: Buffer;
  /** 原样字节（含 length / type / CRC），用于「不动 IHDR / IDAT」的拼接。 */
  raw: Buffer;
}

const parsePngChunks = (buf: Buffer): PngChunk[] => {
  if (buf.length < PNG_SIGNATURE.length + CHUNK_OVERHEAD || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('markGeneratedImage: 输入不是 PNG（签名不匹配）');
  }
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + CHUNK_OVERHEAD <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const end = offset + CHUNK_OVERHEAD + length;
    if (end > buf.length) throw new Error('markGeneratedImage: PNG chunk 长度越界');
    const type = buf.toString('latin1', offset + 4, offset + 8);
    chunks.push({
      type,
      data: buf.subarray(offset + 8, offset + 8 + length),
      raw: buf.subarray(offset, end),
    });
    offset = end;
    if (type === 'IEND') break;
  }
  if (!chunks.some((chunk) => chunk.type === IHDR_TYPE)) {
    throw new Error('markGeneratedImage: PNG 缺少 IHDR 块');
  }
  return chunks;
};

/** `tEXt` 数据段以 `关键字\0文本` 编码（PNG 规范 §11.3.4）；无 NUL 或空关键字时返回 `null`。 */
const textKeyword = (data: Buffer): string | null => {
  const nul = data.indexOf(0);
  if (nul <= 0) return null;
  const keyword = data.toString('latin1', 0, nul);
  return keyword.length >= 1 && keyword.length <= 79 ? keyword : null;
};

/** `length(4) + "tEXt"(4) + keyword\0text + CRC32(4)`，CRC 覆盖 `type + data`。 */
const buildTextChunk = (keyword: string, text: string): Buffer => {
  const data = Buffer.concat([
    Buffer.from(`${keyword}\0`, 'latin1'),
    Buffer.from(text, 'latin1'),
  ]);
  const type = Buffer.from(TEXT_TYPE, 'latin1');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  type.copy(header, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  return Buffer.concat([header, data, crc]);
};

/**
 * PNG 路径（§3.2）：插在 IHDR 之后、IDAT 之前（对「IDAT 之前」的读取器友好，§13.2 待定决策 1）。
 * **幂等**：先移除所有关键字为 `AIGC` 的既有 `tEXt` 块，再插一个新的（`MARK-05`）；
 * IHDR / IDAT 的原样字节直接拼接，**逐字节不变**（`MARK-02`）。
 */
const markPng = (buf: Buffer): Buffer => {
  const chunks = parsePngChunks(buf).filter(
    (chunk) => !(chunk.type === TEXT_TYPE && textKeyword(chunk.data) === AIGC_TEXT_KEYWORD),
  );
  const marker = buildTextChunk(AIGC_TEXT_KEYWORD, AIGC_MARKER);
  const parts: Buffer[] = [PNG_SIGNATURE];
  let inserted = false;
  for (const chunk of chunks) {
    parts.push(chunk.raw);
    if (!inserted && chunk.type === IHDR_TYPE) {
      parts.push(marker);
      inserted = true;
    }
  }
  return Buffer.concat(parts);
};

/** JPEG 路径（§3.2）：写 `IFD0.ImageDescription` 与 `IFD3.UserComment`（`MARK-03`）。 */
const markJpeg = (buf: Buffer): Promise<Buffer> =>
  sharp(buf)
    .withMetadata({
      exif: { IFD0: { ImageDescription: AIGC_MARKER }, IFD3: { UserComment: AIGC_MARKER } },
    })
    .jpeg()
    .toBuffer();

/**
 * 读回 PNG `tEXt` 块的值（关键字匹配才返回，找不到或非 PNG 返回 `null`）。
 * 与 `markPng` 同一套块解析，供单测（`MARK-01` / `MARK-05`）与验收（`CMP-01` / `CMP-04`）读回标识。
 */
export const readPngText = (buf: Buffer, keyword: string): string | null => {
  let chunks: PngChunk[];
  try {
    chunks = parsePngChunks(buf);
  } catch {
    return null;
  }
  for (const chunk of chunks) {
    if (chunk.type !== TEXT_TYPE || textKeyword(chunk.data) !== keyword) continue;
    return chunk.data.subarray(chunk.data.indexOf(0) + 1).toString('latin1');
  }
  return null;
};

/**
 * 为生成图写隐式标识（§3.1）。`AIGC_IMPLICIT_MARKER === 'false'` 时原样返回（§3.5，开关只控制
 * 元数据写入，不影响审计行）；否则写入并返回 `implicit: true`。失败即抛出，由调用方按 §3.4 处理。
 */
export async function markGeneratedImage(
  buf: Buffer,
  format: 'png' | 'jpeg',
): Promise<{ marked: Buffer; implicit: boolean }> {
  if (process.env.AIGC_IMPLICIT_MARKER === 'false') return { marked: buf, implicit: false };
  const marked = format === 'png' ? markPng(buf) : await markJpeg(buf);
  return { marked, implicit: true };
}
