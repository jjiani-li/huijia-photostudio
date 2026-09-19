import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import type { Photo, PromptReverseJob } from '../../src/shared/types';
import { ReversePromptSection } from './reverse-prompt-panel';

/** `next/link` 在 node 环境（非 App Router 运行时）不挂载 router，测试里换成普通 `<a>`。 */
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

/**
 * 反推面板的展示层（`docs/prd/pages/P01-上传与身份确认.md` §4.4）：
 * 默认折叠、逐字文案、超时续看、两个推荐都为 `null` 的出路、失败走 `ErrorNotice`、
 * `resultPrompt` 只作展示。静态渲染即可断言（无状态、无取数）。
 */

const photo = (id: number): Photo => ({
  id,
  kind: 'original',
  url: `/api/photos/${id}/file?w=200`,
  mime: 'image/jpeg',
  bytes: 1024,
  width: 800,
  height: 600,
  sha256: `sha-${id}`,
  createdAt: '2026-09-17T15:07:42.000Z',
});

const job = (over: Partial<PromptReverseJob> = {}): PromptReverseJob => ({
  id: 9,
  status: 'succeeded',
  photoId: 1,
  model: 'vision',
  resultJson: null,
  resultPrompt: null,
  suggestEraCode: null,
  suggestSceneId: null,
  error: null,
  createdAt: '2026-09-17T15:07:42.000Z',
  finishedAt: null,
  ...over,
});

const render = (over: Partial<Parameters<typeof ReversePromptSection>[0]> = {}): string =>
  renderToStaticMarkup(
    <ReversePromptSection
      photos={[photo(1), photo(2)]}
      selectedPhotoId={1}
      expanded={false}
      phase="idle"
      job={null}
      notice={null}
      adopted={false}
      onToggle={() => undefined}
      onSelectPhoto={() => undefined}
      onAdopt={() => undefined}
      onNoticeRetry={() => undefined}
      onRefreshNow={() => undefined}
      {...over}
    />,
  );

describe('折叠入口（§4.4）', () => {
  it('没有上传成功的照片 → 整块不渲染', () => {
    expect(render({ photos: [] })).toBe('');
  });

  it('默认折叠：只有标题，没有说明与 `收起`', () => {
    const html = render();
    expect(html).toContain('用一张旧照片反推');
    expect(html).not.toContain('收起');
    expect(html).not.toContain('挑一张看得出年代的老照片');
  });

  it('展开后给说明与 `收起`，照片缩略图只用响应里的 `url`', () => {
    const html = render({ expanded: true });
    expect(html).toContain('收起');
    expect(html).toContain('挑一张看得出年代的老照片，我们读出它的年代和场景，帮你填好后面的选择。');
    expect(html).toContain('src="/api/photos/1/file?w=200"');
    expect(html).toContain('src="/api/photos/2/file?w=200"');
  });
});

describe('运行中与超时（§4.2 的 `AsyncStatus` 复用）', () => {
  it('任务在跑 / 刚建任务 → `正在读这张照片`', () => {
    expect(render({ expanded: true })).toContain('正在读这张照片');
    expect(render({ expanded: true, job: job({ status: 'running' }) })).toContain('正在读这张照片');
  });

  it('超时 → 追加 `还在处理，可以先去别处看看` 与 `继续看进度`（不自动停）', () => {
    const html = render({ expanded: true, phase: 'timedOut', job: job({ status: 'queued' }) });
    expect(html).toContain('还在处理，可以先去别处看看');
    expect(html).toContain('继续看进度');
  });
});

describe('结果与采纳（§4.4）', () => {
  const succeeded = job({
    resultJson: { scene: '老屋院子', lighting: '午后', era: '八十年代', wardrobe: '棉袄', composition: '中景' },
    resultPrompt: '一位老人站在院子里的自然语言描述',
    suggestEraCode: 'E2',
    suggestSceneId: 3,
  });

  it('展示五项结构化结果、`resultPrompt` 与两个推荐', () => {
    const html = render({ expanded: true, job: succeeded });
    expect(html).toContain('场景 老屋院子');
    expect(html).toContain('光线 午后');
    expect(html).toContain('年代 八十年代');
    expect(html).toContain('服饰 棉袄');
    expect(html).toContain('构图 中景');
    expect(html).toContain('一位老人站在院子里的自然语言描述');
    expect(html).toContain('年代 E2');
    expect(html).toContain('场景 3');
    expect(html).toContain('用这个年代和场景');
    expect(html).not.toContain('正在读这张照片');
  });

  it('采纳后给 `已经帮你选好了，继续往下走。`', () => {
    const html = render({ expanded: true, job: succeeded, adopted: true });
    expect(html).toContain('已经帮你选好了，继续往下走。');
  });

  it('两个推荐都为 `null` → 不给采纳按钮，改提示自己选', () => {
    const html = render({ expanded: true, job: job({ resultJson: { scene: '说不清' } }) });
    expect(html).toContain('这张照片看不出年代，你自己选一个吧。');
    expect(html).not.toContain('用这个年代和场景');
  });
});

describe('失败（§4.4、P00 §8）', () => {
  it('失败走 `ErrorNotice`，主文案取服务端 `error.message`，`重试` 可重来', () => {
    // 容器把 `status='failed'` 的 `job.error` 经 `reverseJobNotice` 转成 `notice` 传进来（§4.4）。
    const html = render({
      expanded: true,
      job: job({ status: 'failed', error: { code: 'PROVIDER_TIMEOUT', message: '生成花的时间有点长，请重试一次' } }),
      notice: { code: 'PROVIDER_TIMEOUT', message: '生成花的时间有点长，请重试一次' },
    });
    expect(html).toContain('生成花的时间有点长，请重试一次');
    expect(html).toContain('role="alert"');
    expect(html).toContain('重试');
  });

  it('建任务失败同样只影响本面板', () => {
    const html = render({ expanded: true, notice: { code: 'NOT_FOUND', message: '这张照片找不到了' } });
    expect(html).toContain('这张照片找不到了');
  });
});
