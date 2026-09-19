/**
 * 结果页与历史页的纯函数（`docs/prd/pages/P03-结果历史与下载.md` §10）：年代徽标三态、年龄偏差提示、
 * 下载文件名、反馈三态。全部无副作用、无取数，可被静态断言。
 */
import type { EraCheck, EraCheckVerdict, Generation, GenerationResult } from './types';

/** 反馈三值（`docs/prd/spec/03-接口契约.md` §3.5）：`-2` = 不像他。 */
export type FeedbackValue = 1 | -1 | -2;

/** 反馈按钮的三个值、文案与顺序（`docs/prd/pages/P03-结果历史与下载.md` §6）。 */
export const FEEDBACK_OPTIONS: ReadonlyArray<{ value: FeedbackValue; label: string }> = [
  { value: 1, label: '喜欢' },
  { value: -1, label: '不喜欢' },
  { value: -2, label: '不像他' },
];

/**
 * 反馈三态（`docs/prd/pages/P03-结果历史与下载.md` §6）：点同一个按钮传 `null` 取消，
 * 点另一个按钮改写；`pending` 期间由调用方禁用按钮。
 */
export const nextFeedback = (
  current: GenerationResult['userFeedback'],
  clicked: FeedbackValue,
): FeedbackValue | null => (current === clicked ? null : clicked);

/** 结果组状态的一句话文案（`docs/prd/pages/P03-结果历史与下载.md` §6）：`partial` / `failed` 出文案，其余 `null`。 */
export const generationStatusNotice = (status: Generation['status']): string | null => {
  if (status === 'partial') return '这几张只成功了一部分';
  if (status === 'failed') return '这次没生成出来';
  return null;
};

const ERA_CHECK_COPY: Record<EraCheckVerdict, string | null> = {
  pass: null,
  review: '可能不符合所选年代，仅供参考',
  reject: '明显不符合所选年代',
};

/**
 * 年代徽标（`docs/prd/pages/P03-结果历史与下载.md` §6 的逐字文案、`modules/M07-生成后复核与内容审核.md` §5.3）：
 * `review` / `reject` 出文案，`eraCheck === null` 出「还没检查」，`pass` 不渲染标注（返回 `null`）。
 * 三态文案互不相同且穷尽（`pages/P03` §10）。
 */
export const eraCheckBadge = (eraCheck: EraCheck | null): string | null => {
  if (eraCheck === null) return '还没检查';
  return ERA_CHECK_COPY[eraCheck.verdict];
};

/** `ageDelta` 的提示阈值（`modules/M07-生成后复核与内容审核.md` §5.5、`spec/00-总纲.md` §4.4）。 */
export const AGE_DELTA_NOTICE_THRESHOLD = 5;

/**
 * 年龄偏差提示（`docs/prd/pages/P03-结果历史与下载.md` §6）：仅 `|ageDelta| > 5` 时返回文案。
 * `age_delta` 是**有符号**整数，负 = 变年轻（`modules/M07` §5.4）；`5` / `-5` / `0` / `null` 一律返回 `null`。
 */
export const ageDeltaNotice = (ageDelta: number | null): string | null => {
  if (ageDelta === null || Math.abs(ageDelta) <= AGE_DELTA_NOTICE_THRESHOLD) return null;
  const years = Math.abs(ageDelta);
  return ageDelta < 0 ? `看起来比原照片年轻了 ${years} 岁` : `看起来比原照片年长 ${years} 岁`;
};

/** 额度不足时的第二行（`pages/P02-年代与场景选择.md` §7、`pages/P00-设计基准与路由.md` §8）：两个数字都要出。 */
export const quotaLine = (remaining: number, limit: number): string => `今天还能生成 ${remaining} 张（每天 ${limit} 张）`;

/**
 * 下载文件名（`docs/prd/pages/P03-结果历史与下载.md` §6、§10）：
 * `回家照相馆-{eraName}-{sceneName}-{ordinal + 1}.{ext}`；`ext` 从 `Generation.params.outputFormat`
 * 派生（`png` → `png`、`jpeg` → `jpg`），**不得硬编码 `.png`**。`ordinal` 为 0 基序号。
 */
export const downloadFileName = (
  eraName: string,
  sceneName: string,
  ordinal: number,
  outputFormat: 'png' | 'jpeg',
): string => {
  const ext = outputFormat === 'jpeg' ? 'jpg' : 'png';
  return `回家照相馆-${eraName}-${sceneName}-${ordinal + 1}.${ext}`;
};

/**
 * 单张原文件的下载地址（`docs/prd/pages/P03-结果历史与下载.md` §4）：`GET /api/photos/:id/file`
 * **不带 `w`** 取原文件；缩略展示用的是响应里的 `url`，只有下载走这条路。
 */
export const photoFileHref = (photoId: number): string => `/api/photos/${photoId}/file`;
