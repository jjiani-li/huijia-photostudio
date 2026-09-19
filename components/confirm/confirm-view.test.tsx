import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import type { Anchor, AnchorFeatures, ConsentScope, Photo } from '../../src/shared/types';
import { ConfirmSkeleton, ConfirmView, type ConfirmViewProps } from './confirm-view';
import {
  CONFIRM_BUTTON_COPY,
  CONFIRMED_CTA_COPY,
  CONFIRMED_NOTICE_COPY,
  CONSENT_COPY,
  CONSENT_FOOTNOTE_COPY,
  CONSENT_INCOMPLETE_COPY,
  FEATURE_TOGGLE_COPY,
  PHOTO_PENDING_COPY,
  RETRY_ANCHOR_COPY,
  UNCHECKED_CONSENTS,
} from './confirm-logic';

/** `next/link` 在 node 环境（非 App Router 运行时）不挂载 router，测试里换成普通 `<a>`。 */
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

/**
 * `/confirm/[anchorId]` 的展示层（`docs/prd/pages/P01-上传与身份确认.md` §4.3 与 §5、
 * `pages/P04-失败与情绪安全路径.md` §3）：提取中 / 失败 / 成功 / 已确认四态、逐字文案、
 * 边界降级。静态渲染即可断言——本组件无状态、无取数。
 */
const photo = (over: Partial<Photo> = {}): Photo => ({
  id: 12,
  kind: 'original',
  url: '/api/photos/12/file?w=800',
  mime: 'image/jpeg',
  bytes: 1024,
  width: 800,
  height: 600,
  sha256: 'a'.repeat(64),
  createdAt: '2026-09-19T00:00:00.000Z',
  ...over,
});

const FEATURES: AnchorFeatures = {
  gender: '女',
  ageRange: '四十上下',
  hair: '齐耳短发',
  faceShape: '鹅蛋脸',
  forehead: '额头饱满',
  eyebrows: '眉毛细',
  eyes: '单眼皮',
  nose: '鼻梁不高',
  mouth: '嘴角微微向下',
  skin: '皮肤偏白',
  distinctive: '右边脸颊有颗痣',
  build: '身形清瘦',
};

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  id: 7,
  status: 'succeeded',
  attempt: 0,
  anchorText: '照片里是一位四十岁上下的女性，齐耳短发，鹅蛋脸，笑起来嘴角微微向下。',
  features: FEATURES,
  model: 'doubao-seed-2-1-turbo-260628',
  promptVersion: 'anchor-v1',
  quality: null,
  confirmedByUser: false,
  confirmedAt: null,
  error: null,
  sourcePhotos: [photo()],
  preprocessedPhoto: photo({ id: 13, kind: 'preprocessed', url: '/api/photos/13/file?w=800' }),
  createdAt: '2026-09-19T00:00:00.000Z',
  finishedAt: '2026-09-19T00:01:00.000Z',
  ...over,
});

const render = (over: Partial<ConfirmViewProps> = {}): string =>
  renderToStaticMarkup(
    <ConfirmView
      anchor={anchor()}
      phase="done"
      notice={null}
      checked={UNCHECKED_CONSENTS}
      invalidScopes={[]}
      featuresOpen={false}
      busy={false}
      retryBusy={false}
      onToggleConsent={() => undefined}
      onToggleFeatures={() => undefined}
      onConfirm={() => undefined}
      onRetry={() => undefined}
      onRefreshNow={() => undefined}
      {...over}
    />,
  );

const ALL_CHECKED: Record<ConsentScope, boolean> = { photo_usage: true, family_agreement: true };

describe('页头与提取中（§4.3）', () => {
  it('标题与说明逐字', () => {
    const html = render();
    expect(html).toContain('这是照片里的那个人吗');
    expect(html).toContain('下面是系统从照片里读到的外貌特征。先确认一下，是不是他。');
  });

  it('queued / running → AsyncStatus 三步提示，无百分比', () => {
    for (const status of ['queued', 'running'] as const) {
      const html = render({ anchor: anchor({ status, anchorText: null, features: null }) });
      expect(html).toContain('role="status"');
      for (const step of ['正在读取照片', '正在辨认脸部特征', '正在整理成文字']) expect(html).toContain(step);
      expect(html).not.toContain('%');
      expect(html).not.toContain('type="checkbox"');
    }
  });

  it('提取中不出对比区 / 锚点文本 / 确认区', () => {
    const html = render({ anchor: anchor({ status: 'running', anchorText: null, features: null }) });
    expect(html).not.toContain('你上传的那张');
    expect(html).not.toContain(PHOTO_PENDING_COPY);
    expect(html).not.toContain(FEATURE_TOGGLE_COPY.collapsed);
  });

  it('超时 → 超时文案 + `继续看进度`（自动轮询停、能力保留）', () => {
    const html = render({ anchor: anchor({ status: 'running', anchorText: null }), phase: 'timedOut' });
    expect(html).toContain('还在处理，可以先去别处看看');
    expect(html).toContain('继续看进度');
    expect(render({ anchor: anchor({ status: 'running' }), phase: 'polling' })).not.toContain('继续看进度');
  });
});

describe('提取失败（§4.3、P04 §3）', () => {
  it('服务端 `error.message` 原样 + `重新提取一次`，不给确认区', () => {
    const html = render({
      anchor: anchor({
        status: 'failed',
        anchorText: null,
        features: null,
        error: { code: 'PROVIDER_TIMEOUT', message: '生成花的时间有点长，请重试一次' },
      }),
    });
    expect(html).toContain('生成花的时间有点长，请重试一次');
    expect(html).toContain(RETRY_ANCHOR_COPY);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain(CONFIRM_BUTTON_COPY);
    expect(html).not.toContain('type="checkbox"');
  });

  it('retry 在途时禁用（非幂等端点）', () => {
    const html = render({
      anchor: anchor({ status: 'failed', error: { code: 'INTERNAL', message: '出了点小问题，请重试' } }),
      retryBusy: true,
    });
    expect(html).toContain('disabled');
    expect(html).toContain(RETRY_ANCHOR_COPY);
  });

  it('失败态不渲染 `重试`（按钮文案是 `重新提取一次`）', () => {
    const html = render({
      anchor: anchor({ status: 'failed', error: { code: 'PROVIDER_ERROR', message: '上游错误' } }),
    });
    expect(html).not.toContain('>重试<');
  });
});

describe('成功态：对比区 / 锚点文本 / 特征（§4.3）', () => {
  it('对比区两侧标签、只用响应 url', () => {
    const html = render();
    expect(html).toContain('你上传的那张');
    expect(html).toContain('我们读取用的那张');
    expect(html).toContain('src="/api/photos/12/file?w=800"');
    expect(html).toContain('src="/api/photos/13/file?w=800"');
  });

  it('`preprocessedPhoto = null` → 右侧占位', () => {
    const html = render({ anchor: anchor({ preprocessedPhoto: null }) });
    expect(html).toContain(PHOTO_PENDING_COPY);
    expect(html.match(/<img/g)).toHaveLength(1);
  });

  it('锚点文本原样展示（正文色，不是 `text-primary`）', () => {
    const html = render();
    expect(html).toContain('照片里是一位四十岁上下的女性');
    expect(html).toContain('text-body text-ink');
  });

  it('折叠区默认折叠；展开态由 props 驱动', () => {
    expect(render()).toContain(FEATURE_TOGGLE_COPY.collapsed);
    const open = render({ featuresOpen: true });
    expect(open).toContain(FEATURE_TOGGLE_COPY.expanded);
    expect(open).toContain('性别');
  });

  it('`features = null` 时隐藏折叠区，锚点文本照常', () => {
    const html = render({ anchor: anchor({ features: null }) });
    expect(html).not.toContain(FEATURE_TOGGLE_COPY.collapsed);
    expect(html).toContain('照片里是一位四十岁上下的女性');
  });

  it('`anchorText` 为空时不渲染确认按钮与确认区', () => {
    const html = render({ anchor: anchor({ anchorText: '' }) });
    expect(html).not.toContain(CONFIRM_BUTTON_COPY);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain(CONSENT_COPY.photo_usage);
  });

  it('正文不出现暗示「变清楚了 / 被修过」的措辞', () => {
    const html = render({ featuresOpen: true });
    for (const banned of ['变清楚', '更清晰', '修复', '增强', '超分', '美化', '复活', '重生']) {
      expect(html).not.toContain(banned);
    }
  });
});

describe('确认区与授权（§4.3、M04 §10）', () => {
  it('未勾选：两项句子逐字、两个框都未预勾选、按钮置灰 + 行内提示', () => {
    const html = render();
    expect(html).toContain(CONSENT_COPY.photo_usage);
    expect(html).toContain(CONSENT_COPY.family_agreement);
    expect(html).toContain(CONSENT_FOOTNOTE_COPY);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).not.toContain('checked');
    expect(html).toContain(`disabled=""`);
    expect(html).toContain(CONFIRM_BUTTON_COPY);
    expect(html).toContain(CONSENT_INCOMPLETE_COPY);
  });

  it('只勾一项仍置灰并保留提示', () => {
    const html = render({ checked: { photo_usage: true, family_agreement: false } });
    expect(html).toContain('disabled=""');
    expect(html).toContain(CONSENT_INCOMPLETE_COPY);
  });

  it('两项都勾上：按钮可点、提示消失', () => {
    const html = render({ checked: ALL_CHECKED });
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('checked=""');
    expect(html).not.toContain(CONSENT_INCOMPLETE_COPY);
  });

  it('请求在途时按钮禁用（非幂等）', () => {
    const html = render({ checked: ALL_CHECKED, busy: true });
    expect(html).toContain('disabled=""');
    expect(html).toContain(CONFIRM_BUTTON_COPY);
  });

  it('`INVALID_PARAM` 命中的勾选项高亮', () => {
    const html = render({ invalidScopes: ['family_agreement'] });
    expect(html.match(/text-danger/g)).toHaveLength(1);
  });

  it('已确认：显示锚点文本与已确认提示，主按钮改为去选年代和场景，不再出勾选框', () => {
    const html = render({ anchor: anchor({ confirmedByUser: true, confirmedAt: '2026-09-19T00:02:00.000Z' }) });
    expect(html).toContain('照片里是一位四十岁上下的女性');
    expect(html).toContain(CONFIRMED_NOTICE_COPY);
    expect(html).toContain(CONFIRMED_CTA_COPY);
    expect(html).toContain('href="/choose/7"');
    expect(html).not.toContain(CONFIRM_BUTTON_COPY);
    expect(html).not.toContain('type="checkbox"');
  });
});

describe('错误呈现与骨架（§5、P00 §8）', () => {
  it('请求错误走 `ErrorNotice` 的 inline 形态，可重试码带 `重试`', () => {
    const html = render({ notice: { code: 'PROVIDER_ERROR', message: '上游错误，稍后再试' } });
    expect(html).toContain('上游错误，稍后再试');
    expect(html).toContain('role="alert"');
    expect(html).toContain('重试');
  });

  it('骨架只有色块：无文字、无图片', () => {
    const html = renderToStaticMarkup(<ConfirmSkeleton />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('照片');
  });
});
