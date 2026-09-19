import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import type { Photo, Quality } from '../../src/shared/types';
import { UploadView } from './upload-view';
import type { UploadCard } from './uploads';

/** `next/link` 在 node 环境（非 App Router 运行时）不挂载 router，测试里换成普通 `<a>`。 */
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

/**
 * `/upload` 的展示层（`docs/prd/pages/P01-上传与身份确认.md` §4.1、§4.2、§4.4 与
 * `pages/P00-设计基准与路由.md` §3.2、§4.2、§9.3）：逐字文案、卡片三态、错误行、置灰与 worker 提示。
 * 静态渲染即可断言——本组件无状态、无取数。
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
  sharpness: 62,
  readability: 70,
  damageLevel: 0.2,
  warnings: [],
  advice: null,
  ...over,
});

const card = (over: Partial<UploadCard> = {}): UploadCard => ({
  key: 'photo-0',
  fileName: 'old.jpg',
  phase: 'ready',
  photo: photo(1),
  preprocessedPhoto: photo(11, 'preprocessed'),
  quality: quality(),
  error: null,
  ...over,
});

const render = (over: Partial<Parameters<typeof UploadView>[0]> = {}): string =>
  renderToStaticMarkup(
    <UploadView
      cards={[]}
      overflowCount={0}
      baselineKey={null}
      workerAlive={true}
      allUnusable={false}
      disabled={false}
      busy={false}
      submitError={null}
      reverse={null}
      onPick={() => undefined}
      onRemove={() => undefined}
      onSetBaseline={() => undefined}
      onRetry={() => undefined}
      onSubmit={() => undefined}
      {...over}
    />,
  );

describe('版面与逐字文案（§4.2）', () => {
  it('标题 / 说明 / 文件选择器 / 主按钮 / 页脚小字', () => {
    const html = render();
    expect(html).toContain('选几张他的照片');
    expect(html).toContain('清楚一点的、正脸的最好。选 1 到 5 张。');
    expect(html).toContain('开始提取面部特征');
    expect(html).toContain('我们会尽力还原照片的样子，但这是基于照片的重建，无法替代真实。');
  });

  it('文件选择器允许多选，`accept` 只列四种格式（大小与类型由服务端判）', () => {
    const html = render();
    expect(html).toContain('type="file"');
    expect(html).toContain('multiple');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp,image/heic"');
  });

  it('空态：未选文件时给出空态文案', () => {
    expect(render()).toContain('还没选照片。点上面的按钮，从相册里挑几张。');
    expect(render({ cards: [card()] })).not.toContain('还没选照片');
  });

  it('超过 5 张 / 全部不可用的两行提示', () => {
    expect(render({ overflowCount: 2 })).toContain('一次最多 5 张，先按前 5 张处理。');
    expect(render()).not.toContain('一次最多 5 张');
    expect(render({ allUnusable: true })).toContain('这几张都不太适合提取特征。换一张清楚的正面照试试。');
  });

  it('不出现禁用措辞（`pages/P00` §9.3）', () => {
    const html = render({ cards: [card(), card({ key: 'photo-1', fileName: 'b.jpg' })], allUnusable: true });
    for (const banned of ['修复', '复活', '重生', '太棒了', '奇迹', '一键还原青春', '逝者']) {
      expect(html).not.toContain(banned);
    }
  });
});

describe('每张卡的状态（§4.2）', () => {
  it('上传中 / 预处理中的逐字文案，未回的卡不渲染质量摘要', () => {
    const uploading = card({ phase: 'uploading', photo: null, quality: null, preprocessedPhoto: null });
    const preprocessing = card({
      key: 'photo-1',
      phase: 'preprocessing',
      quality: null,
      preprocessedPhoto: null,
    });
    const html = render({ cards: [uploading, preprocessing] });
    expect(html).toContain('正在上传…');
    expect(html).toContain('正在读取照片…');
    expect(html).not.toContain('清晰度');
  });

  it('就绪：质量摘要逐字 + 基准标记只落在基准那张', () => {
    const html = render({
      cards: [card({ key: 'a', photo: photo(1) }), card({ key: 'b', photo: photo(2) })],
      baselineKey: 'b',
    });
    expect(html).toContain('清晰度 62 · 可读性 70');
    expect(html.match(/这张最适合当基准/g)).toHaveLength(1);
  });

  it('`warnings[]` 与 `advice` 原样展示；`advice = null` 时不渲染该块', () => {
    const withAdvice = render({
      cards: [
        card({
          quality: quality({
            warnings: ['照片有点模糊', '脸上有反光'],
            advice: '换一张正脸清楚一点的',
          }),
        }),
      ],
    });
    expect(withAdvice).toContain('照片有点模糊');
    expect(withAdvice).toContain('脸上有反光');
    expect(withAdvice).toContain('换一张正脸清楚一点的');

    const withoutAdvice = render({ cards: [card()] });
    expect(withoutAdvice).not.toContain('换一张正脸清楚一点的');
    // 只有卡片列表本身的一个 `<li>`（`<link rel="preload">` 不算，故匹配 `<li>` 而非 `<li`）
    expect(withoutAdvice.match(/<li>/g)).toHaveLength(1);
  });

  it('`usable = false` → `仍然用这张` 次级按钮；可用但非基准 → `用这张当基准`', () => {
    const unusable = render({ cards: [card({ quality: quality({ usable: false }) })] });
    expect(unusable).toContain('仍然用这张');
    expect(unusable).not.toContain('用这张当基准');

    const usable = render({ cards: [card()] });
    expect(usable).toContain('用这张当基准');
    expect(usable).not.toContain('仍然用这张');

    // 已是基准的可用图不再给切换按钮
    const baseline = render({ cards: [card()], baselineKey: 'photo-0' });
    expect(baseline).not.toContain('用这张当基准');
  });

  it('图片只用响应里的 `url`，不构造路径', () => {
    const html = render({ cards: [card()] });
    expect(html).toContain('src="/api/photos/1/file?w=400"');
  });

  it('失败的卡走错误行：文件名 + 服务端 `error.message` + `重试上传`，且不出现在卡片区', () => {
    const html = render({
      cards: [
        card({ key: 'a' }),
        card({
          key: 'b',
          fileName: 'big.jpg',
          phase: 'error',
          photo: null,
          quality: null,
          preprocessedPhoto: null,
          error: { code: 'FILE_TOO_LARGE', message: '这张照片太大了，换一张小一点的' },
        }),
      ],
    });
    expect(html).toContain('big.jpg');
    expect(html).toContain('这张照片太大了，换一张小一点的');
    expect(html).toContain('重试上传');
    expect(html.match(/清晰度/g)).toHaveLength(1); // 只有成功的那张有质量摘要
  });
});

describe('worker 提示（§4.2、P00 §4.2、ERR-04）', () => {
  it('`alive === false` → 提示 + `pnpm worker`，且不禁用主按钮', () => {
    const html = render({ workerAlive: false });
    expect(html).toContain('后台还没启动，图片处理会卡住');
    expect(html).toContain('pnpm worker');
    expect(html).not.toContain('disabled');
  });

  it('`alive === null`（健康检查未回 / 失败）不提示', () => {
    expect(render({ workerAlive: null })).not.toContain('后台还没启动');
    expect(render({ workerAlive: true })).not.toContain('后台还没启动');
  });
});

describe('主按钮的置灰与提交错误（§4.2、§8）', () => {
  it('`disabled` → 按钮带 disabled', () => {
    expect(render({ disabled: true })).toContain('disabled');
    expect(render({ busy: true })).toContain('disabled');
  });

  it('提交失败走 `ErrorNotice` 的 inline 形态，主文案取服务端 message', () => {
    const html = render({ submitError: { code: 'INVALID_PARAM', message: '选择有误，请重新选一下' } });
    expect(html).toContain('选择有误，请重新选一下');
    expect(html).toContain('role="alert"');
  });

  it('反推面板以插槽渲染在错误行与主按钮之间', () => {
    const html = render({ reverse: <p>反推面板占位</p> });
    expect(html).toContain('反推面板占位');
    expect(html.indexOf('反推面板占位')).toBeLessThan(html.indexOf('开始提取面部特征'));
  });
});
