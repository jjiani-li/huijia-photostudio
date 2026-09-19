import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { probeImage } from './probe';

/**
 * `modules/M01-照片资产与存储.md` §6.4：`sharp` 失败分类的唯一映射表。
 */
describe('probeImage', () => {
  it('合法图片 → 读出宽高与 mime', async () => {
    const jpeg = await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toBuffer();
    await expect(probeImage(jpeg)).resolves.toMatchObject({ width: 320, height: 180, mime: 'image/jpeg' });
  });

  it('解码器打不开文件 → INVALID_FILE_TYPE（不是 STORAGE_ERROR）', async () => {
    await expect(probeImage(Buffer.from('this is not an image at all'))).rejects.toMatchObject({
      code: 'INVALID_FILE_TYPE',
    });
  });
});
