import { createHash } from 'node:crypto';
import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import sharp from 'sharp';
import * as zlib from 'node:zlib';
import { arkImageModel } from '../ark';
import { AIGC_MARKER, markGeneratedImage, readPngText } from './mark';

/**
 * `MARK-01`–`MARK-07`（`docs/prd/spec/06-合规与风控.md` §12.1）：隐式标识的写入与读回、
 * 字节级不破坏、CRC-32 正确性、幂等、标记字符串的约束。
 * 输入是 sharp 现场生成的小图，**不依赖任何 fixture**。
 */

/** 独立于 `mark.ts` 的查表 CRC-32（多项式 `0xEDB88320`），用来证明存储的 CRC 真的被算过。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buf: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

interface Chunk {
  type: string;
  data: Buffer;
  crc: number;
  crcInput: Buffer;
}

/** 与 `mark.ts` 无共享代码的 PNG 块解析。 */
const parseChunks = (buf: Buffer): Chunk[] => {
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunks.push({
      type,
      data,
      crc: buf.readUInt32BE(offset + 8 + length),
      crcInput: buf.subarray(offset + 4, offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
};

const aigcChunks = (buf: Buffer): Chunk[] =>
  parseChunks(buf).filter(
    (chunk) => chunk.type === 'tEXt' && chunk.data.toString('latin1').startsWith('AIGC\0'),
  );

// ── EXIF 读回（MARK-03）：只解析 TIFF 结构里的 ASCII 键 ─────────────────────────────

interface Tiff {
  buf: Buffer;
  le: boolean;
}
const readU16 = (t: Tiff, off: number): number => (t.le ? t.buf.readUInt16LE(off) : t.buf.readUInt16BE(off));
const readU32 = (t: Tiff, off: number): number => (t.le ? t.buf.readUInt32LE(off) : t.buf.readUInt32BE(off));

const tiffOf = (exif: Buffer): Tiff => {
  const body = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? exif.subarray(6) : exif;
  return { buf: body, le: body.toString('latin1', 0, 2) === 'II' };
};

const asciiInIfd = (t: Tiff, ifd: number, tag: number): string | null => {
  const count = readU16(t, ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (readU16(t, entry) !== tag) continue;
    const length = readU32(t, entry + 4);
    const start = length <= 4 ? entry + 8 : readU32(t, entry + 8);
    return t.buf.subarray(start, start + length).toString('latin1').replace(/\0+$/, '');
  }
  return null;
};

/**
 * 在 IFD0 与两个子 IFD（`0x8769` Exif IFD、`0x8825` GPS IFD）里找 ASCII 键。
 * **不假定 sharp 把 `IFD3` 写进哪一支**——它实际落 `0x8825`（GPS IFD），而 `UserComment` 的字节内容才是本条断言的对象。
 */
const exifAscii = (exif: Buffer, tag: number): string | null => {
  const t = tiffOf(exif);
  const ifd0 = readU32(t, 4);
  const pointers: Array<number | null> = [null];
  for (let i = 0; i < readU16(t, ifd0); i += 1) {
    const entry = ifd0 + 2 + i * 12;
    const pointer = readU16(t, entry);
    if (pointer === 0x8769 || pointer === 0x8825) pointers.push(readU32(t, entry + 8));
  }
  for (const ifd of pointers) {
    const value = asciiInIfd(t, ifd ?? ifd0, tag);
    if (value !== null) return value;
  }
  return null;
};

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

const pixelHash = async (buf: Buffer): Promise<string> => sha256(await sharp(buf).raw().toBuffer());

const makePng = (): Promise<Buffer> =>
  sharp({ create: { width: 37, height: 19, channels: 3, background: { r: 120, g: 80, b: 60 } } })
    .png()
    .toBuffer();

const makeJpeg = (): Promise<Buffer> =>
  sharp({ create: { width: 37, height: 19, channels: 3, background: { r: 60, g: 120, b: 80 } } })
    .jpeg()
    .toBuffer();

/** 用例默认在「开标识」下跑；置位环境变量的用例自己覆盖后再还原。 */
const savedMarkerEnv = process.env.AIGC_IMPLICIT_MARKER;
beforeEach(() => {
  delete process.env.AIGC_IMPLICIT_MARKER;
});
afterAll(() => {
  if (savedMarkerEnv === undefined) delete process.env.AIGC_IMPLICIT_MARKER;
  else process.env.AIGC_IMPLICIT_MARKER = savedMarkerEnv;
});

describe('AIGC_MARKER 的约束', () => {
  it('MARK-06 纯 ASCII 且含 `AIGC` 与 `service=`', () => {
    expect(AIGC_MARKER).toMatch(/^[\x20-\x7E]+$/);
    expect(AIGC_MARKER).toContain('AIGC');
    expect(AIGC_MARKER).toContain('service=');
  });

  it('MARK-07 模型名与 `ARK_IMAGE_MODEL` 默认值一致', () => {
    const saved = process.env.ARK_IMAGE_MODEL;
    delete process.env.ARK_IMAGE_MODEL;
    try {
      expect(/model=([^;]+)/.exec(AIGC_MARKER)?.[1]).toBe(arkImageModel());
    } finally {
      if (saved === undefined) delete process.env.ARK_IMAGE_MODEL;
      else process.env.ARK_IMAGE_MODEL = saved;
    }
  });
});

describe('PNG 分支', () => {
  it('MARK-01 读回关键字 `AIGC`，值逐字符等于 AIGC_MARKER', async () => {
    const input = await makePng();
    expect(readPngText(input, 'AIGC')).toBeNull();
    const { marked, implicit } = await markGeneratedImage(input, 'png');
    expect(implicit).toBe(true);
    expect(readPngText(marked, 'AIGC')).toBe(AIGC_MARKER);
  });

  it('MARK-02 IHDR / IDAT 逐字节不变、宽高与像素 sha256 不变', async () => {
    const input = await makePng();
    const { marked } = await markGeneratedImage(input, 'png');
    const before = parseChunks(input);
    const after = parseChunks(marked);
    for (const type of ['IHDR', 'IDAT']) {
      expect(after.filter((c) => c.type === type).map((c) => c.data.toString('hex'))).toEqual(
        before.filter((c) => c.type === type).map((c) => c.data.toString('hex')),
      );
    }
    expect(after.map((c) => c.type)).toEqual(
      ['IHDR', 'tEXt', ...before.filter((c) => c.type !== 'IHDR').map((c) => c.type)],
    );
    const [metaIn, metaOut] = await Promise.all([sharp(input).metadata(), sharp(marked).metadata()]);
    expect([metaOut.width, metaOut.height]).toEqual([metaIn.width, metaIn.height]);
    expect(await pixelHash(marked)).toBe(await pixelHash(input));
  });

  it('MARK-04 tEXt 的 CRC-32 正确；篡改数据字节后校验失败', async () => {
    const { marked } = await markGeneratedImage(await makePng(), 'png');
    const chunk = aigcChunks(marked)[0];
    expect(chunk).toBeDefined();
    if (chunk === undefined) return;
    // 存储的 CRC == 独立查表实现 == 数据段 + 类型（PNG 规范 §5.5），也等于 zlib.crc32。
    expect(chunk.crc).toBe(crc32(chunk.crcInput));
    expect(chunk.crc).toBe(zlib.crc32(chunk.crcInput) >>> 0);
    expect(chunk.crc).not.toBe(0);
    const tampered = Buffer.from(chunk.crcInput);
    const at = tampered.length - 1;
    tampered[at] = (tampered[at] ?? 0) ^ 0xff;
    expect(crc32(tampered)).not.toBe(chunk.crc);
  });

  it('MARK-05 幂等：重复标记后仍只有一个 `AIGC` 关键字块', async () => {
    const once = (await markGeneratedImage(await makePng(), 'png')).marked;
    const twice = (await markGeneratedImage(once, 'png')).marked;
    expect(aigcChunks(once)).toHaveLength(1);
    expect(aigcChunks(twice)).toHaveLength(1);
    expect(readPngText(twice, 'AIGC')).toBe(AIGC_MARKER);
  });

  it('AIGC_IMPLICIT_MARKER=false 原样返回（不写元数据）', async () => {
    const input = await makePng();
    process.env.AIGC_IMPLICIT_MARKER = 'false';
    try {
      const { marked, implicit } = await markGeneratedImage(input, 'png');
      expect(implicit).toBe(false);
      expect(marked).toBe(input);
      expect(readPngText(marked, 'AIGC')).toBeNull();
    } finally {
      delete process.env.AIGC_IMPLICIT_MARKER;
    }
  });

  it('非 PNG 输入抛出（失败由调用方按 §3.4 处理）', async () => {
    await expect(markGeneratedImage(Buffer.from('not a png'), 'png')).rejects.toThrow();
  });
});

describe('JPEG 分支', () => {
  it('MARK-03 IFD0.ImageDescription 与 IFD3.UserComment 都等于 AIGC_MARKER', async () => {
    const input = await makeJpeg();
    const { marked, implicit } = await markGeneratedImage(input, 'jpeg');
    expect(implicit).toBe(true);
    const exif = (await sharp(marked).metadata()).exif;
    expect(exif).toBeDefined();
    if (exif === undefined) return;
    expect(exifAscii(exif, 0x010e)).toBe(AIGC_MARKER);
    // `UserComment` 按 EXIF 规范带 8 字节字符编码前缀（sharp 写 `ASCII\0\0\0`）。
    expect(exifAscii(exif, 0x9286)?.replace(/^(ASCII|UNICODE|JIS|[0-9A-F]{8})\0*/, '')).toBe(AIGC_MARKER);
  });

  it('AIGC_IMPLICIT_MARKER=false 原样返回', async () => {
    const input = await makeJpeg();
    process.env.AIGC_IMPLICIT_MARKER = 'false';
    try {
      const { marked, implicit } = await markGeneratedImage(input, 'jpeg');
      expect(implicit).toBe(false);
      expect(marked).toBe(input);
      expect((await sharp(marked).metadata()).exif).toBeUndefined();
    } finally {
      delete process.env.AIGC_IMPLICIT_MARKER;
    }
  });
});
