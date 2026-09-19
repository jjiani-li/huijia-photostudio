import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_FILES, pickBaseline, pickFiles, type BaselineInput } from './upload';
import type { Quality } from './types';

const quality = (over: Partial<Quality>): Quality => ({
  usable: true,
  faceDetected: true,
  faceCount: 1,
  sharpness: 0.5,
  readability: 0.5,
  damageLevel: 0.1,
  warnings: [],
  advice: null,
  ...over,
});

const card = (photoId: number, qualityValue: Quality | null, preprocessedPhotoId = photoId + 100): BaselineInput => ({
  photoId,
  quality: qualityValue,
  preprocessedPhotoId,
});

const ids = (cardList: BaselineInput[]) => cardList.map((c) => c.photoId);

describe('pickFiles（pages/P01-上传与身份确认.md §4.2、§7）', () => {
  it('不超过 5 张 → 全部上传、无未处理', () => {
    expect(pickFiles(['a', 'b', 'c'])).toEqual({ selected: ['a', 'b', 'c'], overflow: [] });
    expect(pickFiles(new Array(MAX_UPLOAD_FILES).fill(0)).overflow).toEqual([]);
  });

  it('超过 5 张 → 按选择顺序取前 5，其余进未处理列表', () => {
    expect(pickFiles(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual({
      selected: ['a', 'b', 'c', 'd', 'e'],
      overflow: ['f'],
    });
    expect(pickFiles(['a', 'b', 'c', 'd', 'e', 'f', 'g']).overflow).toEqual(['f', 'g']);
  });

  it('不读 readability：选文件时它还不存在，只按顺序切', () => {
    // 传进来的就是「选中的文件」，函数不做任何按质量重排。
    expect(pickFiles([3, 1, 2, 5, 4, 6]).selected).toEqual([3, 1, 2, 5, 4]);
  });
});

describe('pickBaseline（pages/P01 §4.2、§7）', () => {
  it('readability 降序取第一张', () => {
    const cards = [card(1, quality({ readability: 0.4 })), card(2, quality({ readability: 0.8 })), card(3, quality({ readability: 0.6 }))];
    expect(pickBaseline(cards)?.photoId).toBe(2);
  });

  it('readability 同值 → 按 sharpness 降序', () => {
    const cards = [
      card(1, quality({ readability: 0.7, sharpness: 0.2 })),
      card(2, quality({ readability: 0.7, sharpness: 0.9 })),
    ];
    expect(pickBaseline(cards)?.photoId).toBe(2);
  });

  it('usable=false 一律排后，即使 readability 更高', () => {
    const cards = [
      card(1, quality({ usable: false, readability: 0.99, advice: '换一张' })),
      card(2, quality({ readability: 0.2 })),
    ];
    expect(pickBaseline(cards)?.photoId).toBe(2);
  });

  it('quality=null（预处理未回）不参与比较', () => {
    expect(pickBaseline([card(1, null), card(2, quality({ readability: 0.3 }))])?.photoId).toBe(2);
    expect(pickBaseline([card(1, null)])).toBeNull();
  });

  it('全部不可用 → null', () => {
    expect(pickBaseline([card(1, quality({ usable: false })), card(2, quality({ usable: false }))])).toBeNull();
    expect(pickBaseline([])).toBeNull();
  });

  it('返回整张卡片（宿主拿它的 preprocessedPhotoId 作 preprocessedPhotoId）', () => {
    const best = pickBaseline([card(1, quality({ readability: 0.9 }), 77)]);
    expect(best).toEqual({ photoId: 1, quality: expect.any(Object), preprocessedPhotoId: 77 });
    expect(ids(best === null ? [] : [best])).toEqual([1]);
  });
});
