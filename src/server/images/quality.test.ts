import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { scoreQuality, type AnalysisInput } from './quality';
import { buildAnalysisInput, normalize } from './preprocess';

/**
 * `PRE-08`–`PRE-12`（`docs/prd/modules/M02-预处理与质量评分.md` §8.1）：评分的 A 层断言。
 */
const hist = (pixels: number, value: number): number[] => {
  const buckets = new Array<number>(256).fill(0);
  buckets[value] = pixels;
  return buckets;
};

const input = (over: Partial<AnalysisInput> = {}): AnalysisInput => ({
  gray1024: new Uint8Array(1000 * 1000),
  stats: { channels: [{ stdev: 50 }], sharpness: 2 },
  histogram: hist(1000 * 1000, 128),
  width: 1000,
  height: 1000,
  faceBox: null,
  faceDetected: true,
  faceCount: 1,
  resized: true,
  degenerateFace: false,
  ...over,
});

describe('PRE-08 全黑图', () => {
  it('damageLevel > 0.6、usable=false、advice 命中第 2 或第 3 行', async () => {
    const black = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .jpeg()
      .toBuffer();
    const n = await normalize(black);
    const analysis = await buildAnalysisInput(n.buffer, n.width, n.height, n.resized);
    // 全黑图的中心高频能量为 0（退化路径判无人脸），这里只验证损坏判定与 advice 两行，故显式置为「已检出人脸」
    const q = scoreQuality({ ...analysis, faceDetected: true, faceCount: 1 });

    expect(q.damageLevel).toBeGreaterThan(0.6);
    expect(q.usable).toBe(false);
    expect([
      '这张照片太模糊或者太暗，人物特征看不清，建议换一张更清楚的',
      '这张照片褪色或者破损得比较厉害，可能认不准长相，建议换一张保存得更好的',
    ]).toContain(q.advice);
  });
});

describe('PRE-09 真实留存照片可用', () => {
  it('docs/老照片/1b26e45303c7321fa589d4525b43aa0.jpg → usable=true、readability >= 0.35', async () => {
    const n = await normalize(await sharp('docs/老照片/1b26e45303c7321fa589d4525b43aa0.jpg').toBuffer());
    const q = scoreQuality(await buildAnalysisInput(n.buffer, n.width, n.height, n.resized));
    expect(q.usable).toBe(true);
    expect(q.readability).toBeGreaterThanOrEqual(0.35);
  });
});

describe('PRE-10 faceSizeScore 权重', () => {
  it('faceBox 占长边 2% → faceSizeScore=0（其余子分不变，readability 差恰 0.15）', () => {
    const small = scoreQuality(input({ faceBox: { x: 0, y: 0, w: 20, h: 20 } })); // 2% of 1000
    const big = scoreQuality(input({ faceBox: { x: 0, y: 0, w: 500, h: 500 } })); // 50%
    expect(small.sharpness).toBe(big.sharpness);
    expect(small.damageLevel).toBe(big.damageLevel);
    // faceSizeScore: 2% → 0；50% → 1；权重 0.15
    expect(Math.abs(big.readability - small.readability - 0.15)).toBeLessThan(0.001);
  });
});

describe('PRE-11 标定表回归', () => {
  const samples: Array<[string, () => Promise<Buffer>, [number, number, number]]> = [
    [
      'black',
      () => sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer(),
      [0, 0.44, 1.0],
    ],
    [
      'blur',
      () => sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 128, g: 128, b: 128 } } }).blur(30).jpeg().toBuffer(),
      [0, 0.44, 0.5],
    ],
    [
      'highContrast',
      () =>
        sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 0 } } })
          .composite([{ input: { create: { width: 500, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } } }, left: 500, top: 0 }])
          .jpeg()
          .toBuffer(),
      [0.311, 0.768, 0.968],
    ],
    [
      'tiny',
      () => sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 90, g: 120, b: 60 } } }).jpeg().toBuffer(),
      [0, 0.125, 0.5],
    ],
  ];

  it.each(samples)('%s 的 sharpness/readability/damageLevel 落在标定表 ±0.05', async (_name, make, expected) => {
    const n = await normalize(await make());
    const q = scoreQuality(await buildAnalysisInput(n.buffer, n.width, n.height, n.resized));
    const actual = [q.sharpness, q.readability, q.damageLevel];
    expected.forEach((e, i) => expect(Math.abs((actual[i] ?? 0) - e)).toBeLessThanOrEqual(0.05));
  });
});

describe('PRE-12 输出形状', () => {
  it('恰 8 个键、顺序固定、浮点三位小数', () => {
    const q = scoreQuality(input());
    expect(Object.keys(q)).toEqual([
      'usable',
      'faceDetected',
      'faceCount',
      'sharpness',
      'readability',
      'damageLevel',
      'warnings',
      'advice',
    ]);
    for (const key of ['sharpness', 'readability', 'damageLevel'] as const) {
      expect(Math.round(q[key] * 1000) / 1000).toBe(q[key]);
    }
  });
});
