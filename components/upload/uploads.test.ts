import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../../src/shared/api-client';
import type { Photo, Quality } from '../../src/shared/types';
import {
  anchorRequest,
  cardLabel,
  errorRows,
  extractDisabled,
  isAllUnusable,
  isInFlight,
  noticeOf,
  photoIds,
  reverseDetails,
  reverseJobNotice,
  canAdoptReverse,
  selectBaseline,
  successfulPhotos,
  visibleCards,
  type UploadCard,
} from './uploads';

/**
 * `/upload` 的纯逻辑（`docs/prd/pages/P01-上传与身份确认.md` §4.2、§4.4、§7）：
 * 基准图判定、`photoIds` 组成、置灰判据、错误行、反推结果投影。不依赖网络与 React。
 */

const photo = (id: number, kind: Photo['kind'] = 'original'): Photo => ({
  id,
  kind,
  url: `/api/photos/${id}/file?w=400`,
  mime: 'image/jpeg',
  bytes: 1024,
  width: 800,
  height: 600,
  sha256: `sha-${id}`,
  createdAt: '2026-09-17T15:07:42.000Z',
});

const quality = (over: Partial<Quality> = {}): Quality => ({
  usable: true,
  faceDetected: true,
  faceCount: 1,
  sharpness: 60,
  readability: 60,
  damageLevel: 0.2,
  warnings: [],
  advice: null,
  ...over,
});

interface CardInput {
  key?: string;
  phase?: UploadCard['phase'];
  photoId?: number | null;
  preprocessedPhotoId?: number | null;
  quality?: Quality | null;
  error?: UploadCard['error'];
}

const card = ({
  key = 'photo-0',
  phase = 'ready',
  photoId = 1,
  preprocessedPhotoId = 11,
  quality: q = quality(),
  error = null,
}: CardInput = {}): UploadCard => ({
  key,
  fileName: `${key}.jpg`,
  phase,
  photo: photoId === null ? null : photo(photoId),
  preprocessedPhoto: preprocessedPhotoId === null ? null : photo(preprocessedPhotoId, 'preprocessed'),
  quality: q,
  error,
});

describe('基准图判定（§4.2、§7；排序本体在 `src/shared/upload.ts`）', () => {
  it('取 `readability` 最高的一张；同值按 `sharpness` 降序', () => {
    const low = card({ key: 'a', photoId: 1, quality: quality({ readability: 40, sharpness: 90 }) });
    const high = card({ key: 'b', photoId: 2, quality: quality({ readability: 80, sharpness: 10 }) });
    const tie = card({ key: 'c', photoId: 3, quality: quality({ readability: 80, sharpness: 50 }) });
    expect(selectBaseline([low, high, tie], null)?.key).toBe('c');
  });

  it('`usable = false` 不作默认基准，即使它的分数更高', () => {
    const unusable = card({
      key: 'a',
      photoId: 1,
      quality: quality({ usable: false, readability: 99, sharpness: 99 }),
    });
    const usable = card({ key: 'b', photoId: 2, quality: quality({ readability: 10, sharpness: 10 }) });
    expect(selectBaseline([unusable, usable], null)?.key).toBe('b');
  });

  it('全部不可用且未手选 → `null`（主按钮因此禁用）', () => {
    const cards = [
      card({ key: 'a', photoId: 1, quality: quality({ usable: false }) }),
      card({ key: 'b', photoId: 2, quality: quality({ usable: false }) }),
    ];
    expect(selectBaseline(cards, null)).toBeNull();
    expect(isAllUnusable(cards)).toBe(true);
    expect(extractDisabled({ cards, manualPhotoId: null, busy: false })).toBe(true);
  });

  it('`仍然用这张` 是手选：选中不可用的一张后主按钮可点，且只改基准、不重传', () => {
    const cards = [card({ key: 'a', photoId: 1, quality: quality({ usable: false }) })];
    expect(selectBaseline(cards, 1)?.key).toBe('a');
    expect(extractDisabled({ cards, manualPhotoId: 1, busy: false })).toBe(false);
  });

  it('手选优先于自动排序；手选的图已被移除则回落到自动排序', () => {
    const better = card({ key: 'a', photoId: 1, quality: quality({ readability: 90 }) });
    const worse = card({ key: 'b', photoId: 2, quality: quality({ readability: 10 }) });
    expect(selectBaseline([better, worse], 2)?.key).toBe('b');
    expect(selectBaseline([better, worse], 999)?.key).toBe('a');
  });

  it('预处理未回的卡不参与比较（`quality = null`）', () => {
    const pending = card({ key: 'a', photoId: 1, phase: 'preprocessing', quality: null, preprocessedPhotoId: null });
    const ready = card({ key: 'b', photoId: 2, quality: quality({ readability: 1 }) });
    expect(selectBaseline([pending, ready], null)?.key).toBe('b');
  });
});

describe('`photoIds` 与请求体（§4.2）', () => {
  it('`photoIds` = 全部上传成功的原图 id，按选择顺序；失败的与未传完的不在内', () => {
    const cards = [
      card({ key: 'a', photoId: 1 }),
      card({ key: 'b', phase: 'error', photoId: null, quality: null, preprocessedPhotoId: null }),
      card({ key: 'c', photoId: 3, phase: 'preprocessing', quality: null, preprocessedPhotoId: null }),
    ];
    expect(photoIds(cards)).toEqual([1, 3]);
    expect(successfulPhotos(cards)).toHaveLength(2);
  });

  it('请求体带基准的 `preprocessedPhotoId`；为 `null` 时整个字段省略', () => {
    const cards = [card({ key: 'a', photoId: 1, preprocessedPhotoId: 11 })];
    expect(anchorRequest(cards, cards[0]!)).toEqual({ photoIds: [1], preprocessedPhotoId: 11 });

    const noPreprocessed = card({ key: 'a', photoId: 1, preprocessedPhotoId: null });
    expect(anchorRequest([noPreprocessed], noPreprocessed)).toEqual({ photoIds: [1] });
    expect('preprocessedPhotoId' in (anchorRequest([noPreprocessed], noPreprocessed) ?? {})).toBe(false);
  });

  it('没有基准或没有可用照片 → `null`（调用方不得发起请求）', () => {
    const cards = [card({ key: 'a', photoId: 1 })];
    expect(anchorRequest(cards, null)).toBeNull();
    expect(anchorRequest([], null)).toBeNull();
  });
});

describe('置灰判据（§4.2）', () => {
  const ready = card({ key: 'a', photoId: 1 });

  it('上传 / 预处理在途 → 置灰', () => {
    for (const phase of ['uploading', 'preprocessing'] as const) {
      const cards = [card({ key: 'a', phase, quality: null, preprocessedPhotoId: null })];
      expect(isInFlight(cards)).toBe(true);
      expect(extractDisabled({ cards, manualPhotoId: null, busy: false })).toBe(true);
    }
    expect(isInFlight([ready])).toBe(false);
  });

  it('`POST /api/anchors` 在途 → 置灰（非幂等）', () => {
    expect(extractDisabled({ cards: [ready], manualPhotoId: null, busy: true })).toBe(true);
    expect(extractDisabled({ cards: [ready], manualPhotoId: null, busy: false })).toBe(false);
  });
});

describe('卡片与错误行（§4.2 的组件树）', () => {
  it('相位文案：`uploading` / `preprocessing` 各有逐字文案，`ready` 无', () => {
    expect(cardLabel('uploading')).toBe('正在上传…');
    expect(cardLabel('preprocessing')).toBe('正在读取照片…');
    expect(cardLabel('ready')).toBeNull();
  });

  it('失败的卡走错误行（服务端 message 原样），其余卡照常展示', () => {
    const cards = [
      card({ key: 'a', photoId: 1 }),
      card({
        key: 'b',
        phase: 'error',
        photoId: null,
        quality: null,
        preprocessedPhotoId: null,
        error: { code: 'FILE_TOO_LARGE', message: '这张照片太大了，换一张小一点的' },
      }),
    ];
    expect(visibleCards(cards).map((item) => item.key)).toEqual(['a']);
    expect(errorRows(cards)).toEqual([
      { key: 'b', fileName: 'b.jpg', code: 'FILE_TOO_LARGE', message: '这张照片太大了，换一张小一点的' },
    ]);
  });

  it('`isAllUnusable` 只在都跑完且没有一张可用时为真；有错误行时不成立', () => {
    expect(isAllUnusable([])).toBe(false);
    expect(isAllUnusable([card({ quality: quality({ usable: false }) })])).toBe(true);
    expect(
      isAllUnusable([
        card({ key: 'a', quality: quality({ usable: false }) }),
        card({ key: 'b', phase: 'error', photoId: null, quality: null, preprocessedPhotoId: null }),
      ]),
    ).toBe(false);
  });
});

describe('失败文案的取舍（§5、`src/shared/api-error-message.ts`）', () => {
  it('服务端 `error.message` 原样优先', () => {
    const err = new ApiClientError('FILE_TOO_LARGE', '这张照片太大了，换一张小一点的', 413);
    expect(noticeOf(err)).toEqual({ code: 'FILE_TOO_LARGE', message: '这张照片太大了，换一张小一点的' });
  });

  it('没有 envelope（网络级失败）或空 message → 用 `apiErrorMessage` 兜底，不露出技术串', () => {
    expect(noticeOf(new TypeError('Failed to fetch'))).toEqual({ code: 'INTERNAL', message: '出了点小问题，请重试' });
    expect(noticeOf(new ApiClientError('STORAGE_ERROR', '   ', 500))).toEqual({
      code: 'STORAGE_ERROR',
      message: '保存失败，请重试',
    });
  });
});

describe('反推结果的展示投影（§4.4）', () => {
  it('五项按固定顺序投影，缺失或非字符串的键不渲染', () => {
    expect(
      reverseDetails({ scene: '老屋院子', lighting: '午后', era: '八十年代', wardrobe: '棉袄', composition: '中景' }),
    ).toEqual([
      { key: 'scene', label: '场景', value: '老屋院子' },
      { key: 'lighting', label: '光线', value: '午后' },
      { key: 'era', label: '年代', value: '八十年代' },
      { key: 'wardrobe', label: '服饰', value: '棉袄' },
      { key: 'composition', label: '构图', value: '中景' },
    ]);
    expect(reverseDetails({ scene: '老屋院子', era: 12 })).toEqual([
      { key: 'scene', label: '场景', value: '老屋院子' },
    ]);
    expect(reverseDetails(null)).toEqual([]);
  });

  it('两个推荐都为 `null` → 不可采纳；任一非空即可采纳', () => {
    const job = (suggestEraCode: string | null, suggestSceneId: number | null) => ({
      id: 1,
      status: 'succeeded' as const,
      photoId: 1,
      model: 'm',
      resultJson: null,
      resultPrompt: null,
      suggestEraCode,
      suggestSceneId,
      error: null,
      createdAt: '2026-09-17T15:07:42.000Z',
      finishedAt: null,
    });
    expect(canAdoptReverse(job(null, null))).toBe(false);
    expect(canAdoptReverse(job('E2', null))).toBe(true);
    expect(canAdoptReverse(job(null, 3))).toBe(true);
    expect(canAdoptReverse(null)).toBe(false);
  });

  it('失败的任务取服务端 `error.message`；成功 / 进行中不给错误', () => {
    const failed = {
      id: 1,
      status: 'failed' as const,
      photoId: 1,
      model: 'm',
      resultJson: null,
      resultPrompt: null,
      suggestEraCode: null,
      suggestSceneId: null,
      error: { code: 'PROVIDER_TIMEOUT', message: '生成花的时间有点长，请重试一次' },
      createdAt: '2026-09-17T15:07:42.000Z',
      finishedAt: null,
    };
    expect(reverseJobNotice(failed)).toEqual({
      code: 'PROVIDER_TIMEOUT',
      message: '生成花的时间有点长，请重试一次',
    });
    expect(reverseJobNotice({ ...failed, status: 'running' as const })).toBeNull();
    expect(reverseJobNotice(null)).toBeNull();
  });
});
