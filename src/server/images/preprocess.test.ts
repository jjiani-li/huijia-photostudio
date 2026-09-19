import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { probeImage } from './probe';
import { normalize } from './preprocess';

/**
 * `PRE-01`–`PRE-07`（`docs/prd/modules/M02-预处理与质量评分.md` §8.1）：归一化流水线的 A 层断言。
 */
const makeJpeg = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 120, g: 140, b: 160 } } })
    .jpeg()
    .toBuffer();

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

describe('PRE-01 EXIF 方向校正', () => {
  it('Orientation=6 的输入 → 输出宽高互换', async () => {
    const base = await makeJpeg(600, 400);
    const oriented = await sharp(base).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect((await sharp(oriented).metadata()).orientation).toBe(6);

    const out = await normalize(oriented);
    expect(out.width).toBe(400);
    expect(out.height).toBe(600);
  });
});

describe('PRE-02 元数据剥离', () => {
  it('输出 mime=image/jpeg，exif/icc/iptc/xmp 全部 undefined', async () => {
    const out = await normalize(await makeJpeg(300, 200));
    expect((await probeImage(out.buffer)).mime).toBe('image/jpeg');
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
  });
});

describe('PRE-03 尺寸归一', () => {
  it('4000×3000 → 长边恰 1600，resized=true，宽高比误差 < 1px', async () => {
    const out = await normalize(await makeJpeg(4000, 3000));
    expect(out.resized).toBe(true);
    expect(Math.max(out.width, out.height)).toBe(1600);
    // 4000:3000 = 4:3 → 1600×1200
    expect(Math.abs(out.width / out.height - 4 / 3) * out.width).toBeLessThan(1);
    expect(out.width).toBe(1600);
    expect(out.height).toBe(1200);
  });
});

describe('PRE-04 绝不放大', () => {
  it('800×600 输入 → 输出仍 800×600，resized=false', async () => {
    const out = await normalize(await makeJpeg(800, 600));
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
    expect(out.resized).toBe(false);
  });
});

describe('PRE-05 色彩空间统一', () => {
  it('CMYK 输入 → 输出 space 为 srgb', async () => {
    const cmyk = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 200, g: 100, b: 50 } } })
      .toColourspace('cmyk')
      .jpeg()
      .toBuffer();
    const out = await normalize(cmyk);
    expect((await sharp(out.buffer).metadata()).space).toBe('srgb');
  });
});

describe('PRE-06 编码确定性', () => {
  it('同一输入两次归一化 → sha256 相同', async () => {
    const input = await makeJpeg(500, 400);
    const a = await normalize(input);
    const b = await normalize(input);
    expect(sha256(a.buffer)).toBe(sha256(b.buffer));
  });
});

describe('PRE-07 alpha 通道', () => {
  it('带 alpha 的 png → 输出 jpeg 无 alpha 且不报错', async () => {
    const png = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    const out = await normalize(png);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.hasAlpha).toBe(false);
  });
});
