import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import type { Generation, GenerationResult } from '../../src/shared/types';
import { ResultSkeleton, ResultView } from './result-view';
import { SafetyNoticeBody } from './safety-notice';

/** `next/link` 在 node 环境（非 App Router 运行时）不挂载 router，测试里换成普通 `<a>`。 */
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

/**
 * `/result/[generationId]` 的展示层（`docs/prd/pages/P03-结果历史与下载.md` §6、
 * `pages/P04-失败与情绪安全路径.md` §4、§5）：逐字文案、年代徽标三态、年龄偏差、反馈三态、
 * 下载文件名、worker 明确报错、三态与超时。静态渲染即可断言——本组件无状态、无取数。
 */
const result = (over: Partial<GenerationResult> = {}): GenerationResult => {
  const photoId = over.photoId ?? 101;
  return {
    id: 11,
    photoId,
    url: `/api/photos/${photoId}/file?w=400`,
    width: 1024,
    height: 1024,
    seed: 7,
    eraCheck: { passed: true, verdict: 'pass', findings: [], model: 'm' },
    ageDelta: 0,
    realismScore: null,
    userFeedback: null,
    ...over,
  };
};

const generation = (over: Partial<Generation> = {}): Generation => ({
  id: 5,
  status: 'succeeded',
  eraCode: 'E2',
  eraName: '彩色胶卷那阵子',
  sceneId: 3,
  sceneName: '老屋院子',
  requestedCount: 2,
  attempt: 0,
  prompt: '内部字段，不应出现',
  templateVersion: 'v1',
  params: { size: '2048x2048', outputFormat: 'png', watermark: false, provider: 'mock' },
  error: null,
  createdAt: '2026-09-19T00:00:00.000Z',
  finishedAt: '2026-09-19T00:01:00.000Z',
  results: [result(), result({ id: 12, photoId: 102 })],
  ...over,
});

const render = (over: Partial<Parameters<typeof ResultView>[0]> = {}): string =>
  renderToStaticMarkup(
    <ResultView
      generation={generation()}
      phase="done"
      workerAlive={null}
      pendingFeedbackId={null}
      notice={null}
      retryBusy={false}
      openIndex={null}
      onFeedback={() => undefined}
      onRetry={() => undefined}
      onDownloadAll={() => undefined}
      onOpen={() => undefined}
      onCloseLightbox={() => undefined}
      onLightboxIndexChange={() => undefined}
      onRefreshNow={() => undefined}
      {...over}
    />,
  );

describe('页头与网格（§6）', () => {
  it('页头写 `{eraName} · {sceneName}` 与 `共 {requestedCount} 张`', () => {
    const html = render();
    expect(html).toContain('彩色胶卷那阵子 · 老屋院子');
    expect(html).toContain('共 2 张');
  });

  it('不展示 prompt / templateVersion / provider / realismScore / seed（§2）', () => {
    const html = render();
    expect(html).not.toContain('内部字段，不应出现');
    expect(html).not.toContain('templateVersion');
    expect(html).not.toContain('mock');
  });

  it('结果卡有缩略图、`下载这张` 与下载链接（不带 `w` 取原文件）', () => {
    const html = render();
    expect(html).toContain('src="/api/photos/101/file?w=400"');
    expect(html).toContain('href="/api/photos/101/file"');
    expect(html.match(/下载这张/g)).toHaveLength(2);
  });

  it('下载文件名的扩展名从 outputFormat 派生（jpeg → .jpg）', () => {
    const html = render({ generation: generation({ params: { size: 's', outputFormat: 'jpeg', watermark: false, provider: 'mock' } }) });
    expect(html).toContain('download="回家照相馆-彩色胶卷那阵子-老屋院子-1.jpg"');
    expect(html).toContain('download="回家照相馆-彩色胶卷那阵子-老屋院子-2.jpg"');
  });

  it('多张时给 `全部下载`；单张不给', () => {
    expect(render()).toContain('全部下载');
    expect(render({ generation: generation({ results: [result()] }) })).not.toContain('全部下载');
  });
});

describe('年代徽标与年龄偏差（§6 的边界）', () => {
  it('pass 不渲染标注；review / reject / null 各出文案', () => {
    expect(render()).not.toContain('可能不符合所选年代');
    expect(render({ generation: generation({ results: [result({ eraCheck: { passed: false, verdict: 'review', findings: [], model: 'm' } })] }) })).toContain('可能不符合所选年代，仅供参考');
    expect(render({ generation: generation({ results: [result({ eraCheck: { passed: false, verdict: 'reject', findings: [], model: 'm' } })] }) })).toContain('明显不符合所选年代');
    expect(render({ generation: generation({ results: [result({ eraCheck: null })] }) })).toContain('还没检查');
  });

  it('review 展开列出 findings 的 item 与 reason', () => {
    const html = render({
      generation: generation({
        results: [result({ eraCheck: { passed: false, verdict: 'review', findings: [{ item: '电车', reason: '年代不符' }], model: 'm' } })],
      }),
    });
    expect(html).toContain('电车：年代不符');
  });

  it('reject 不隐藏结果图、不阻断下载（只标注）', () => {
    const html = render({ generation: generation({ results: [result({ eraCheck: { passed: false, verdict: 'reject', findings: [], model: 'm' } })] }) });
    expect(html).toContain('下载这张');
    expect(html).toContain('src="/api/photos/101/file?w=400"');
  });

  it('年龄偏差仅 |x| > 5 出现：-8 变年轻、8 年长、5 不出现', () => {
    expect(render({ generation: generation({ results: [result({ ageDelta: -8 })] }) })).toContain('看起来比原照片年轻了 8 岁');
    expect(render({ generation: generation({ results: [result({ ageDelta: 8 })] }) })).toContain('看起来比原照片年长 8 岁');
    expect(render({ generation: generation({ results: [result({ ageDelta: 5 })] }) })).not.toContain('看起来比原照片');
    expect(render({ generation: generation({ results: [result({ ageDelta: null })] }) })).not.toContain('看起来比原照片');
  });
});

describe('反馈三态（§6、P04 §5）', () => {
  it('三个按钮：喜欢 / 不喜欢 / 不像他', () => {
    const html = render();
    for (const label of ['喜欢', '不喜欢', '不像他']) expect(html).toContain(label);
  });

  it('`不像他` 同时给 `换一张照片再来` → /upload 的路', () => {
    const html = render({ generation: generation({ results: [result({ userFeedback: -2 })] }) });
    expect(html).toContain('换一张照片再来');
    expect(html).toContain('href="/upload"');
  });

  it('未选 `不像他` 时不给那条出路', () => {
    expect(render()).not.toContain('换一张照片再来');
  });

  it('请求期间禁用它自己那张的三个按钮', () => {
    const html = render({ pendingFeedbackId: 11 });
    expect(html.match(/disabled=""/g)?.length).toBe(3);
  });
});

describe('三态与超时（§5、§6）', () => {
  it('queued + worker.alive=false → 明确报错（含 `pnpm worker`，不走 ErrorNotice）', () => {
    const html = render({ generation: generation({ status: 'queued', results: [] }), workerAlive: false });
    expect(html).toContain('后台还没启动，图片处理会卡住');
    expect(html).toContain('pnpm worker');
    expect(html).not.toContain('role="alert"');
  });

  it('worker.alive=true 时不报错', () => {
    expect(render({ generation: generation({ status: 'queued', results: [] }), workerAlive: true })).not.toContain('后台还没启动');
  });

  it('非终态出定性进度，无百分比', () => {
    const html = render({ generation: generation({ status: 'running' }), phase: 'polling' });
    expect(html).toContain('正在生成，大概要等一会儿');
    expect(html).not.toContain('%');
  });

  it('超时保留 `继续看进度` 与超时文案', () => {
    const html = render({ generation: generation({ status: 'running' }), phase: 'timedOut' });
    expect(html).toContain('还在处理，可以先去别处看看');
    expect(html).toContain('继续看进度');
  });

  it('succeeded → `用同样设定再来一组`，不再显示进度', () => {
    const html = render();
    expect(html).toContain('用同样设定再来一组');
    expect(html).not.toContain('正在生成');
  });

  it('partial → 部分成功文案 + `再试一次`，成功结果照常展示', () => {
    const html = render({ generation: generation({ status: 'partial' }) });
    expect(html).toContain('这几张只成功了一部分');
    expect(html).toContain('再试一次');
    expect(html).toContain('下载这张');
  });

  it('failed → 失败文案 + 服务端 error.message + `再试一次`', () => {
    const html = render({
      generation: generation({ status: 'failed', results: [], error: { code: 'PROVIDER_ERROR', message: '生成服务暂时不可用，请稍后重试' } }),
    });
    expect(html).toContain('这次没生成出来');
    expect(html).toContain('生成服务暂时不可用，请稍后重试');
    expect(html).toContain('再试一次');
  });

  it('反馈 / retry 的错误走 ErrorNotice（inline）', () => {
    const html = render({ notice: { code: 'GENERATION_IN_PROGRESS', message: '上一组还在生成，稍等一下' } });
    expect(html).toContain('上一组还在生成，稍等一下');
  });
});

describe('放大查看（§6）', () => {
  it('openIndex 为 null 不渲染弹层；非 null 渲染并给上一张 / 下一张 / 关闭', () => {
    expect(render()).not.toContain('role="dialog"');
    const html = render({ openIndex: 1 });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('下一张');
    expect(html).toContain('关闭');
    expect(html).toContain('src="/api/photos/102/file?w=400"');
  });
});

describe('情感安全提示（P04 §4、CMP-06）', () => {
  it('语义句逐字存在', () => {
    expect(renderToStaticMarkup(<SafetyNoticeBody />)).toContain(
      '我们会尽力还原照片的样子，但这是基于照片的重建，无法替代真实。',
    );
  });

  it('骨架不含文字与图片', () => {
    const html = renderToStaticMarkup(<ResultSkeleton />);
    expect(html).not.toContain('<img');
    expect(html).toContain('aria-hidden="true"');
  });
});
