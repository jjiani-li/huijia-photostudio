/**
 * `/upload` 的纯逻辑与逐字文案（`docs/prd/pages/P01-上传与身份确认.md` §4.2、§4.4、§7）：
 * 每张卡的状态、基准图选择、`POST /api/anchors` 的请求体与置灰判据，全部是可测的纯函数，
 * 不依赖 React / 网络 / 存储。
 *
 * 选文件的上限与基准图排序在 `src/shared/upload.ts`（`pickFiles` / `pickBaseline`），这里只做组装。
 */
import type { Photo, PromptReverseJob, Quality } from '../../src/shared/types';
import { ApiClientError, type ApiNotice } from '../../src/shared/api-client';
import { apiErrorMessage } from '../../src/shared/api-error-message';
import { SAFETY_NOTICE_TEXT } from '../../src/shared/safety-notice';
import { pickBaseline } from '../../src/shared/upload';

/**
 * 服务端 `error.message` 优先（`pages/P01` §5）；没有 envelope 的网络级失败（`fetch` 抛 TypeError）
 * 与空 message 用 `apiErrorMessage(code)` 兜底，不把技术串呈现给用户（`src/shared/api-error-message.ts`）。
 */
export const noticeOf = (err: unknown): ApiNotice => {
  if (err instanceof ApiClientError) {
    return { code: err.code, message: err.message.trim() === '' ? apiErrorMessage(err.code) : err.message };
  }
  return { code: 'INTERNAL', message: apiErrorMessage('INTERNAL') };
};

// ── 逐字文案（`pages/P01` §4.2、§4.4 的表格；前端不另写、不改写）────────────────────────────

export const UPLOAD_TITLE = '选几张他的照片';
export const UPLOAD_DESCRIPTION = '清楚一点的、正脸的最好。选 1 到 5 张。';
export const PICK_LABEL = '选照片';
export const EMPTY_COPY = '还没选照片。点上面的按钮，从相册里挑几张。';
export const UPLOADING_COPY = '正在上传…';
export const PREPROCESSING_COPY = '正在读取照片…';
export const BASELINE_TAG_COPY = '这张最适合当基准';
export const KEEP_THIS_COPY = '仍然用这张';
export const MANUAL_BASELINE_COPY = '用这张当基准';
export const REMOVE_COPY = '移除';
export const RETRY_UPLOAD_COPY = '重试上传';
export const OVERFLOW_COPY = '一次最多 5 张，先按前 5 张处理。';
export const ALL_UNUSABLE_COPY = '这几张都不太适合提取特征。换一张清楚的正面照试试。';
export const EXTRACT_COPY = '开始提取面部特征';
/** 页脚常驻的情感安全同义行：语义句的唯一落点是 `src/shared/safety-notice.ts`（`CMP-06`），这里只引用。 */
export const FOOTER_NOTE_COPY = SAFETY_NOTICE_TEXT;

/** 文件选择器的 `accept`（`pages/P01` §4.2）：heic 是否可解码取决于服务端构建，前端照收不误。 */
export const UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic';

/** 质量摘要（`pages/P01` §4.2）：`清晰度 {sharpness} · 可读性 {readability}`。 */
export const qualitySummary = (quality: Quality): string =>
  `清晰度 ${quality.sharpness} · 可读性 ${quality.readability}`;

// ── 每张卡的状态 ────────────────────────────────────────────────────────────────────────

/**
 * 单张卡的相位（`pages/P01` §4.2）：上传中 → 预处理中 → 就绪；任一步失败落 `error`，
 * 由 `UploadErrorList` 单独成行（该行显示服务端 `error.message` + `重试上传`）。
 */
export type UploadPhase = 'uploading' | 'preprocessing' | 'ready' | 'error';

/** 展示成卡片的相位（`error` 走 `UploadErrorList`，见 `errorRows`）。 */
export type CardPhase = Exclude<UploadPhase, 'error'>;

export interface UploadCard {
  /** 选择顺序上的稳定键（不落存储，仅本页 local state 用）。 */
  key: string;
  /** 只作行内标题，不参与任何请求。 */
  fileName: string;
  phase: UploadPhase;
  /** `POST /api/photos` 的 `201 { photo }`；上传成功前为 `null`。 */
  photo: Photo | null;
  /** `POST /api/photos/:id/preprocess` 的 `{ photo, quality }`；未回为 `null`。 */
  preprocessedPhoto: Photo | null;
  quality: Quality | null;
  /** 上传 / 预处理失败：主文案取服务端 `error.message`（`pages/P01` §5）。 */
  error: ApiNotice | null;
}

/** 卡片相位对应的状态文案（`ready` 由质量摘要代替，`error` 由错误行承担）。 */
export const cardLabel = (phase: CardPhase): string | null => {
  if (phase === 'uploading') return UPLOADING_COPY;
  if (phase === 'preprocessing') return PREPROCESSING_COPY;
  return null;
};

/** 仍在飞行的卡（`pages/P01` §4.2：有在途请求时主按钮禁用）。 */
export const isInFlight = (cards: readonly UploadCard[]): boolean =>
  cards.some((card) => card.phase === 'uploading' || card.phase === 'preprocessing');

/** 上传成功的 `original` 图，按选择顺序（`POST /api/anchors` 的 `photoIds` 用它）。 */
export const successfulPhotos = (cards: readonly UploadCard[]): Photo[] =>
  cards.flatMap((card) => (card.photo === null ? [] : [card.photo]));

/** `photoIds` = 全部上传成功的 `original` 图 id（≤ 5，`pages/P01` §4.2）。 */
export const photoIds = (cards: readonly UploadCard[]): number[] =>
  successfulPhotos(cards).map((photo) => photo.id);

/** 呈现给用户的卡片与错误行（`pages/P01` §4.2 的组件树：`PhotoQualityCard × n` + `UploadErrorList`）。 */
export type VisibleCard = UploadCard & { phase: CardPhase };

export const visibleCards = (cards: readonly UploadCard[]): VisibleCard[] =>
  cards.filter((card): card is VisibleCard => card.phase !== 'error');

export interface UploadErrorRow {
  key: string;
  fileName: string;
  code: string;
  message: string;
}

export const errorRows = (cards: readonly UploadCard[]): UploadErrorRow[] =>
  cards
    .filter((card) => card.phase === 'error')
    .map((card) => ({
      key: card.key,
      fileName: card.fileName,
      code: card.error?.code ?? 'INTERNAL',
      message: card.error?.message ?? '',
    }));

/**
 * 全部不可用（`pages/P01` §4.2）：都跑完了预处理，且没有一张 `usable = true`。
 * 错误行不算「不可用」——它们是没跑成，另有各行的重试入口。
 */
export const isAllUnusable = (cards: readonly UploadCard[]): boolean =>
  cards.length > 0 &&
  cards.every((card) => card.phase === 'ready' && card.quality !== null && !card.quality.usable);

// ── 基准图与发起提取 ────────────────────────────────────────────────────────────────────

/**
 * 当前基准图（`pages/P01` §4.2、§7）：用户手选优先（手选只改 `preprocessedPhotoId`，不重传），
 * 否则用 `pickBaseline` 在 `usable = true` 里按 `readability` / `sharpness` 取第一张。
 * `usable = false` 的图只有在用户显式点了 `仍然用这张` 之后才成为基准；都没有则 `null`，
 * 此时主按钮禁用（`pages/P01` §6 降级项 2）。
 */
export const selectBaseline = (
  cards: readonly UploadCard[],
  manualPhotoId: number | null,
): UploadCard | null => {
  const manual =
    manualPhotoId === null
      ? null
      : (cards.find((card) => card.photo?.id === manualPhotoId && card.quality !== null) ?? null);
  if (manual !== null) return manual;

  const best = pickBaseline(
    cards.map((card) => ({
      card,
      photoId: card.photo?.id ?? 0,
      quality: card.quality,
      preprocessedPhotoId: card.preprocessedPhoto?.id ?? null,
    })),
  );
  return best === null ? null : best.card;
};

/** `POST /api/anchors` 的请求体（`docs/prd/spec/03-接口契约.md` §3.3）：`preprocessedPhotoId` 为 `null` 时**整个字段省略**。 */
export interface AnchorRequest {
  photoIds: number[];
  preprocessedPhotoId?: number;
}

/** 组装请求体；条件不满足（没有可用照片 / 没有基准）返回 `null`，调用方不得发起请求。 */
export const anchorRequest = (
  cards: readonly UploadCard[],
  baseline: UploadCard | null,
): AnchorRequest | null => {
  const ids = photoIds(cards);
  if (baseline === null || ids.length === 0) return null;
  const preprocessedPhotoId = baseline.preprocessedPhoto?.id ?? null;
  return preprocessedPhotoId === null ? { photoIds: ids } : { photoIds: ids, preprocessedPhotoId };
};

export interface ExtractGateInput {
  cards: readonly UploadCard[];
  /** 用户手选的基准图（原图 id）；未手选为 `null`。 */
  manualPhotoId: number | null;
  /** `POST /api/anchors` 在途（该端点非幂等，`spec/03-接口契约.md` §1.5）。 */
  busy: boolean;
}

/**
 * 主按钮的置灰判据（`pages/P01` §4.2）：请求在途 → 仍有上传 / 预处理在途 → 没有基准图
 * （`usable = true` 一张都没有，且用户也没有点 `仍然用这张`）。判据与发起时同源。
 */
export const extractDisabled = (input: ExtractGateInput): boolean =>
  input.busy || isInFlight(input.cards) || selectBaseline(input.cards, input.manualPhotoId) === null;

// ── 反推面板的展示（`pages/P01` §4.4）──────────────────────────────────────────────────

export const REVERSE_TITLE = '用一张旧照片反推';
export const REVERSE_COLLAPSE_COPY = '收起';
export const REVERSE_DESCRIPTION = '挑一张看得出年代的老照片，我们读出它的年代和场景，帮你填好后面的选择。';
export const REVERSE_RUNNING_COPY = '正在读这张照片';
export const REVERSE_ADOPT_COPY = '用这个年代和场景';
export const REVERSE_ADOPTED_COPY = '已经帮你选好了，继续往下走。';
export const REVERSE_NO_ERA_COPY = '这张照片看不出年代，你自己选一个吧。';

/** `resultJson` 的五键与其中文标签（`docs/prd/spec/05-Prompt工程.md` §11 的字段表；顺序即展示顺序）。 */
export const REVERSE_DETAIL_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['scene', '场景'],
  ['lighting', '光线'],
  ['era', '年代'],
  ['wardrobe', '服饰'],
  ['composition', '构图'],
];

export interface ReverseDetail {
  key: string;
  label: string;
  value: string;
}

/** 只读展示的五项；缺失或非字符串的键不渲染（不做兜底文案、不改写服务端原文）。 */
export const reverseDetails = (resultJson: Record<string, unknown> | null): ReverseDetail[] =>
  resultJson === null
    ? []
    : REVERSE_DETAIL_LABELS.flatMap(([key, label]) => {
        const value = resultJson[key];
        return typeof value === 'string' && value !== '' ? [{ key, label, value }] : [];
      });

/** 两个推荐都是 `null` → 不给采纳按钮，改提示用户自己选（`pages/P01` §4.4）。 */
export const canAdoptReverse = (job: PromptReverseJob | null): boolean =>
  job !== null && (job.suggestEraCode !== null || job.suggestSceneId !== null);

/** `status='failed'` 的反推任务 → `ErrorNotice` 的入参（`pages/P01` §4.4：取服务端 `error.message`）。 */
export const reverseJobNotice = (job: PromptReverseJob | null): ApiNotice | null =>
  job !== null && job.status === 'failed'
    ? { code: job.error?.code ?? 'INTERNAL', message: job.error?.message ?? apiErrorMessage('INTERNAL') }
    : null;
