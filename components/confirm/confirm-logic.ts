import { getFieldNames, type ApiNotice } from '../../src/shared/api-client';
import { errorMessageOf } from '../../src/shared/error-message';
import { CONSENT_SCOPES, type Anchor, type AnchorFeatures, type ConsentScope } from '../../src/shared/types';

/**
 * `/confirm/[anchorId]` 的纯逻辑与逐字文案（`docs/prd/pages/P01-上传与身份确认.md` §4.3、
 * `docs/prd/modules/M04-身份确认与授权.md` §10）：勾选态、缺失项高亮、锚点状态判据与路由，
 * 全部可单测，不依赖 React / 网络。文案**只在这里出现一次**，组件不得另写。
 */

/** 提取中的三步步骤提示（`pages/P01` §4.3）。只是**文案分段**，不与服务端进度绑定（服务端只给 `status`）。 */
export const EXTRACT_STEPS: readonly string[] = ['正在读取照片', '正在辨认脸部特征', '正在整理成文字'];

/** 轮询的终止状态（`docs/prd/spec/03-接口契约.md` §2.1：锚点提取终止于这两个值）。 */
export const TERMINAL_ANCHOR_STATUSES: ReadonlyArray<Anchor['status']> = ['succeeded', 'failed'];

export const isTerminalAnchor = (status: Anchor['status']): boolean =>
  TERMINAL_ANCHOR_STATUSES.includes(status);

/** 两项授权的逐字文案（权威来源 `modules/M04` §10），顺序即 `CONSENT_SCOPES` 顺序。 */
export const CONSENT_COPY: Record<ConsentScope, string> = {
  photo_usage: '我确认我手上有这张照片的使用权，也确认照片里的人是我认识的人。',
  family_agreement: '我已经和家里其他亲属说过这件事，他们同意我用这张照片来做。',
};

/** 勾选框下方小字（`modules/M04` §10）：默认可见、不可折叠。 */
export const CONSENT_FOOTNOTE_COPY = '如果家里有不同意见，请先沟通好再来做。';

/** 未勾满时的行内提示（`modules/M04` §10）。 */
export const CONSENT_INCOMPLETE_COPY = '需要两项都勾上才能开始';

/** 提交按钮文案（`modules/M04` §10）。 */
export const CONFIRM_BUTTON_COPY = '这就是他，开始生成';

/** 已确认后的主按钮文案（`pages/P01` §4.3）。 */
export const CONFIRMED_CTA_COPY = '去选年代和场景';

/** 已确认提示（`pages/P01` §4.3）。 */
export const CONFIRMED_NOTICE_COPY = '这个人物特征已经确认过了';

/** 提取失败时的重试按钮（`pages/P01` §4.3）。 */
export const RETRY_ANCHOR_COPY = '重新提取一次';

/** 对比区两侧的标签（`pages/P01` §4.3）：**不得**暗示「变清楚了 / 被修过」。 */
export const COMPARE_LABELS = {
  before: '你上传的那张',
  after: '我们读取用的那张',
} as const;

/** 右侧预处理图未回时的占位（`pages/P01` §4.3 的边界）。 */
export const PHOTO_PENDING_COPY = '照片还在处理';

/**
 * 12 项特征的标签，**顺序即 `AnchorFeatures` 的键序**（`pages/P01` §4.3 的逐字表）：
 * `gender` `ageRange` `hair` `faceShape` `forehead` `eyebrows` `eyes` `nose` `mouth` `skin`
 * `distinctive` `build`。
 */
export const FEATURE_LABELS: ReadonlyArray<{ key: keyof AnchorFeatures; label: string }> = [
  { key: 'gender', label: '性别' },
  { key: 'ageRange', label: '年龄段' },
  { key: 'hair', label: '发型' },
  { key: 'faceShape', label: '脸型' },
  { key: 'forehead', label: '额头' },
  { key: 'eyebrows', label: '眉毛' },
  { key: 'eyes', label: '眼睛' },
  { key: 'nose', label: '鼻子' },
  { key: 'mouth', label: '嘴部' },
  { key: 'skin', label: '皮肤' },
  { key: 'distinctive', label: '显著特征' },
  { key: 'build', label: '体型' },
];

/** 折叠标题两态（`pages/P01` §4.3）：收起态写项数，展开态写「收起」。 */
export const FEATURE_TOGGLE_COPY = { collapsed: '他长这样（12 项特征）', expanded: '收起' } as const;

/** 初始勾选态：两项都**未勾选**，前端不得预勾选（`modules/M04` §10）。 */
export const UNCHECKED_CONSENTS: Record<ConsentScope, boolean> = {
  photo_usage: false,
  family_agreement: false,
};

/** 提交给 `POST /api/anchors/:id/confirm` 的 `consents`：**只提交勾上的项**，顺序与文案无关（`modules/M04` §10）。 */
export const consentScopes = (checked: Record<ConsentScope, boolean>): ConsentScope[] =>
  CONSENT_SCOPES.filter((scope) => checked[scope]);

/** 两项都勾上才可提交（`pages/P01` §4.3：按钮置灰与行内提示同源）。 */
export const allConsentsChecked = (checked: Record<ConsentScope, boolean>): boolean =>
  CONSENT_SCOPES.every((scope) => checked[scope]);

const asConsentScope = (value: unknown): ConsentScope | null =>
  (CONSENT_SCOPES as readonly unknown[]).includes(value) ? (value as ConsentScope) : null;

/**
 * `400 INVALID_PARAM` 的 `details.fields.consents` → 要**高亮**的勾选项（缺失项，
 * `modules/M04` §6、`pages/P00` §8：只高亮控件、不展示 `details` 原文）。
 * 服务端没给出具体缺失项时按两项都缺处理。
 */
export const invalidConsentScopes = (details: unknown): ConsentScope[] => {
  const fields = getFieldNames(details).includes('consents')
    ? (details as { fields: { consents?: unknown } }).fields.consents
    : undefined;
  const missing = Array.isArray(fields)
    ? fields.map(asConsentScope).filter((scope): scope is ConsentScope => scope !== null)
    : [];
  return missing.length > 0 ? missing : [...CONSENT_SCOPES];
};

export const confirmHref = (anchorId: number): string => `/confirm/${anchorId}`;

export const chooseHref = (anchorId: number): string => `/choose/${anchorId}`;

/**
 * `status='failed'` 且服务端没给 `error` 时的兜底 notice（契约里不会出现，只为 `ErrorNotice`
 * 拿到一个可渲染的形状）；文案取 `docs/prd/spec/03-接口契约.md` §5 的 `INTERNAL` 示例，不自造。
 */
export const FAILED_FALLBACK_NOTICE: ApiNotice = {
  code: 'INTERNAL',
  message: errorMessageOf('INTERNAL'),
};
