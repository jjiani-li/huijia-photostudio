import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Generation, HistoryItem, Photo, PhotoList } from '../../src/shared/types';
import {
  EMPTY_HISTORY_COPY,
  HistorySkeleton,
  HistoryView,
  deleteDialogCopy,
  deleteSuccessLines,
} from './history-view';

/**
 * `/history` 的展示层（`docs/prd/pages/P03-结果历史与下载.md` §7、§8）：链路三段、逐字文案、
 * 「没走完的照片」区块与独立游标、两级删除的确认文案与不可恢复告知。静态渲染即可断言。
 */
const photo = (over: Partial<Photo> = {}): Photo => ({
  id: 31,
  kind: 'original',
  url: '/api/photos/31/file?w=400',
  mime: 'image/jpeg',
  bytes: 1000,
  width: 800,
  height: 600,
  sha256: 'a'.repeat(64),
  createdAt: '2026-09-19T00:00:00.000Z',
  ...over,
});

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
  params: { size: 's', outputFormat: 'png', watermark: false, provider: 'mock' },
  error: null,
  createdAt: '2026-09-19T00:00:00.000Z',
  finishedAt: null,
  results: [],
  ...over,
});

const item = (over: Partial<HistoryItem> = {}): HistoryItem => ({
  anchorId: 7,
  anchorText: '短发、圆脸、额头高',
  confirmedAt: '2026-09-19T00:00:00.000Z',
  sourcePhoto: photo(),
  preprocessedPhoto: photo({ id: 32, kind: 'preprocessed' }),
  generations: [generation()],
  ...over,
});

const incomplete: PhotoList = {
  items: [photo(), photo({ id: 33, kind: 'generated' }), photo({ id: 34, kind: 'preprocessed' })],
  nextCursor: null,
};

const render = (over: Partial<Parameters<typeof HistoryView>[0]> = {}): string =>
  renderToStaticMarkup(
    <HistoryView
      items={[item()]}
      loading={false}
      workerAlive={null}
      hasMore={false}
      historyError={null}
      photos={incomplete}
      photosError={null}
      noticeLines={[]}
      noticeError={null}
      dialog={null}
      busy={false}
      onRegenerate={() => undefined}
      onRequestDelete={() => undefined}
      onConfirmDelete={() => undefined}
      onCancelDelete={() => undefined}
      onLoadMoreChain={() => undefined}
      onLoadMorePhotos={() => undefined}
      onReloadPhotos={() => undefined}
      onReloadHistory={() => undefined}
      {...over}
    />,
  );

describe('标题与空态（§7）', () => {
  it('标题为 `生成过的记录`', () => {
    expect(render()).toContain('生成过的记录');
  });

  it('无记录且没有下一页 → 空态文案', () => {
    const html = render({ items: [], photos: null });
    expect(html).toContain(EMPTY_HISTORY_COPY);
  });

  it('还有下一页时不显示空态', () => {
    const html = render({ items: [], hasMore: true, photos: null });
    expect(html).not.toContain(EMPTY_HISTORY_COPY);
  });
});

describe('链路三段（§7）', () => {
  it('三段标签为 `原照片` → `人物特征` → `生成的照片`', () => {
    const html = render();
    expect(html).toContain('原照片');
    expect(html).toContain('人物特征');
    expect(html).toContain('生成的照片');
  });

  it('锚点文字、`eraName × sceneName` 与 `用同样设定再生成` 都在', () => {
    const html = render();
    expect(html).toContain('短发、圆脸、额头高');
    expect(html).toContain('彩色胶卷那阵子 · 老屋院子');
    expect(html).toContain('用同样设定再生成');
  });

  it('不展示 prompt / templateVersion', () => {
    expect(render()).not.toContain('内部字段，不应出现');
  });

  it('generation 的 `partial` 状态按 §6 文案标注', () => {
    const html = render({ items: [item({ generations: [generation({ status: 'partial' })] })] });
    expect(html).toContain('这几张只成功了一部分');
  });

  it('`再往下看` 仅在 nextCursor 非 null 时出现', () => {
    expect(render()).not.toContain('再往下看');
    expect(render({ hasMore: true })).toContain('再往下看');
  });

  it('记录为空且加载中 → 骨架（无文字、无图片）', () => {
    const html = render({ items: [], loading: true, photos: null });
    expect(html).not.toContain('<img');
    expect(html).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<HistorySkeleton />)).toContain('aria-hidden="true"');
  });
});

describe('两级删除入口（§8）', () => {
  it('链路级与生成部分级两个入口都在', () => {
    const html = render();
    expect(html).toContain('删掉这次记录');
    expect(html).toContain('只删生成的这几张');
  });

  it('没有 generation 时不显示「只删生成的这几张」', () => {
    expect(render({ items: [item({ generations: [] })] })).not.toContain('只删生成的这几张');
  });

  it('三种确认文案与「删了拿不回来」硬要求（§7、§8）', () => {
    expect(deleteDialogCopy('chain').title).toBe('删掉这次记录？');
    expect(deleteDialogCopy('chain').body).toContain('删了拿不回来');
    expect(deleteDialogCopy('anchor').title).toBe('只删掉生成的部分？');
    expect(deleteDialogCopy('anchor').body).toContain('删了拿不回来');
    expect(deleteDialogCopy('photo').title).toBe('删掉这张照片？');
    expect(deleteDialogCopy('photo').body).toContain('删了拿不回来');
    for (const level of ['chain', 'anchor', 'photo'] as const) {
      const copy = deleteDialogCopy(level);
      expect(`${copy.confirmLabel}/${copy.cancelLabel}`).toBe('删掉/算了');
      expect(copy.body).not.toMatch(/恢复|回收站|找回/);
    }
  });

  it('确认弹层只在有目标时渲染，并逐字显示标题与按钮', () => {
    expect(render()).not.toContain('role="dialog"');
    const html = render({ dialog: { level: 'chain', id: 31 } });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('删掉这次记录？');
    expect(html).toContain('算了');
  });

  it('成功提示：`删掉了` 与 `一起删掉了 N 张生成图`；区块删除只有前半句', () => {
    expect(deleteSuccessLines('chain', 3)).toEqual(['删掉了', '一起删掉了 3 张生成图']);
    expect(deleteSuccessLines('anchor', 2)).toEqual(['删掉了', '一起删掉了 2 张生成图']);
    expect(deleteSuccessLines('photo', 0)).toEqual(['删掉了']);
    expect(deleteSuccessLines('chain', null)).toEqual(['删掉了']);
  });

  it('成功提示渲染在页面里', () => {
    const html = render({ noticeLines: deleteSuccessLines('chain', 3) });
    expect(html).toContain('删掉了');
    expect(html).toContain('一起删掉了 3 张生成图');
  });
});

describe('「没走完的照片」区块（§7 硬要求）', () => {
  it('标题、说明与三种 kind 文案', () => {
    const html = render();
    expect(html).toContain('没走完的照片');
    expect(html).toContain('这些照片还在，随时可以删掉。');
    expect(html).toContain('原照片');
    expect(html).toContain('我们读取用的那张');
    expect(html).toContain('生成的照片');
  });

  it('每行有缩略图、创建时间与 `删掉这张`', () => {
    const html = render();
    expect(html).toContain('src="/api/photos/31/file?w=400"');
    expect(html).toContain('2026-09-19T00:00:00.000Z');
    expect(html.match(/删掉这张/g)).toHaveLength(3);
  });

  it('空列表时整个区块不渲染', () => {
    const html = render({ photos: { items: [], nextCursor: null } });
    expect(html).not.toContain('没走完的照片');
    expect(html).not.toContain('删掉这张');
  });

  it('区块自己的 `再往下看` 由独立游标驱动', () => {
    const html = render({ photos: { items: [photo()], nextCursor: 'pf|abc' } });
    expect(html).toContain('再往下看');
  });
});

describe('错误呈现（§7）', () => {
  it('链路失败 → 错误块 + 重新加载（ErrorNotice 的可重试控件）', () => {
    const html = render({ items: [], historyError: { code: 'INTERNAL', message: '出了点小问题，请重试' } });
    expect(html).toContain('出了点小问题，请重试');
    expect(html).toContain('重试');
  });

  it('区块失败只影响区块（链路照常渲染）', () => {
    const html = render({ photos: null, photosError: { code: 'INTERNAL', message: '出了点小问题，请重试' } });
    expect(html).toContain('彩色胶卷那阵子 · 老屋院子');
    expect(html).toContain('出了点小问题，请重试');
  });
});

describe('worker 未存活（§5、ERR-04）', () => {
  it('workerAlive=false → 明确报错，不走 ErrorNotice', () => {
    const html = render({ workerAlive: false });
    expect(html).toContain('后台还没启动，图片处理会卡住');
    expect(html).toContain('pnpm worker');
    expect(html).not.toContain('role="alert"');
  });

  it('workerAlive=true → 不报错', () => {
    expect(render({ workerAlive: true })).not.toContain('后台还没启动');
  });
});
