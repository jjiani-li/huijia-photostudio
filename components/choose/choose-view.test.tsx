import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EraSceneConfig } from '../../src/shared/types';
import { ChooseView } from './choose-view';
import type { Selection } from './selection';

/**
 * `/choose/[anchorId]` 的展示层（`docs/prd/pages/P02-年代与场景选择.md` §4、§5、§7、§8 与
 * `pages/P00-设计基准与路由.md` §12）：样片两态、低置信提示、置灰与逐字文案。
 * 静态渲染即可断言——本组件无状态、无取数（选择由 URL 读出后当 props 传进来）。
 */
const ERAS = [
  { code: 'E1', name: '更早的从前', slug: 'e1', isMono: true, caption: '年代说明 E1', sampleUrl: null, sortOrder: 1 },
  { code: 'E2', name: '彩色胶卷那阵子', slug: 'e2', isMono: false, caption: '彩色胶卷，颜色有点偏，颗粒明显，照相馆和老院子的年代', sampleUrl: '/samples/era-E2.png', sortOrder: 2 },
];

const SCENES = [
  { id: 1, code: 'S1', name: '照相馆', slug: 's1', category: null, caption: '当年街口那家照相馆，布景布、假花、铁椅子', coverUrl: '/samples/scene-S1.png', sortOrder: 1 },
  { id: 3, code: 'S3', name: '老屋院子', slug: 's3', category: null, caption: '院子里的老屋与树', coverUrl: null, sortOrder: 2 },
];

const CONFIG: EraSceneConfig = {
  version: 'seed-v1',
  confidenceHintThreshold: 0.6,
  realismAnchor: 'x',
  eras: ERAS,
  scenes: SCENES,
  profiles: [
    { eraCode: 'E2', sceneId: 1, confidence: 0.8, visualSignature: 'E2×S1 的画面特征', sampleUrl: null },
    { eraCode: 'E2', sceneId: 3, confidence: 0.2, visualSignature: 'E2×S3 的画面特征', sampleUrl: null },
  ],
};

const SELECTED: Selection = { eraCode: 'E2', sceneId: 1, count: 2 };

const render = (over: Partial<Parameters<typeof ChooseView>[0]> = {}): string =>
  renderToStaticMarkup(
    <ChooseView
      config={CONFIG}
      selection={SELECTED}
      remaining={20}
      busy={false}
      submitError={null}
      onSelectEra={() => undefined}
      onSelectScene={() => undefined}
      onChangeCount={() => undefined}
      onGenerate={() => undefined}
      {...over}
    />,
  );

describe('版面与逐字文案（§7）', () => {
  it('标题 / 说明 / 分区标题 / 张数', () => {
    const html = render();
    expect(html).toContain('让他出现在哪个年代、哪个地方');
    expect(html).toContain('先选年代，再选场景。两个都可以随时改。');
    expect(html).toContain('先选年代');
    expect(html).toContain('再选场景');
    expect(html).toContain('你选的组合');
    expect(html).toContain('生成几张');
    for (const label of ['2 张', '3 张', '4 张']) expect(html).toContain(label);
  });

  it('`isMono` 的年代标「黑白」，其余不标', () => {
    const html = render();
    expect(html).toContain('黑白');
    // 只有一个年代是黑白（E1），E2 不带标记。
    expect(html.match(/黑白/g)).toHaveLength(1);
  });

  it('四个年代 / 五个场景卡片按配置渲染，`caption` 原样展示', () => {
    const html = render();
    expect(html).toContain('彩色胶卷，颜色有点偏，颗粒明显，照相馆和老院子的年代');
    expect(html).toContain('当年街口那家照相馆，布景布、假花、铁椅子');
  });
});

describe('样片两种状态（§4，SampleSlot 是唯一实现点）', () => {
  it('有样片渲染 `<img>`，无样片不渲染 `<img>`、图位写「暂无示例」', () => {
    const withSample = render();
    expect(withSample).toContain('<img');
    expect(withSample).toContain('src="/samples/era-E2.png"');
    // E1 年代、S3 场景、组合档案三处都没有样片 → 各自一个「暂无示例」
    expect(withSample.match(/暂无示例/g)).toHaveLength(3);
  });

  it('样片全为 `null`（`seed-v1` 的常态）时整页仍是纯文字选择，且没有占位图', () => {
    const html = render({
      config: {
        ...CONFIG,
        eras: ERAS.map((era) => ({ ...era, sampleUrl: null })),
        scenes: SCENES.map((scene) => ({ ...scene, coverUrl: null })),
      },
    });
    expect(html).not.toContain('<img');
    expect(html.match(/暂无示例/g)).toHaveLength(5);
  });
});

describe('组合预览与低置信提示（§5）', () => {
  it('命中档案且有样片 → 图 + `visualSignature`；无样片 → 只显示 `visualSignature`', () => {
    expect(render()).toContain('E2×S1 的画面特征');
    expect(render({ selection: { eraCode: 'E2', sceneId: 3, count: 2 } })).toContain('E2×S3 的画面特征');
  });

  it('低置信（0.2 < 阈值 0.6）→ 加一行温和提示；同一组合的 0.8 不提示', () => {
    const low = render({ selection: { eraCode: 'E2', sceneId: 3, count: 2 } });
    expect(low).toContain('这两样配在一起的老照片不多，出来可能不太像那个年代。');
    expect(render()).not.toContain('这两样配在一起的老照片不多');
  });

  it('等于阈值不提示（阈值来自响应，不是写死的 0.6）', () => {
    const evenConfig: EraSceneConfig = {
      ...CONFIG,
      confidenceHintThreshold: 0.2,
      profiles: [{ ...CONFIG.profiles[1]!, confidence: 0.2 }],
    };
    expect(render({ config: evenConfig, selection: { eraCode: 'E2', sceneId: 3, count: 2 } })).not.toContain(
      '这两样配在一起的老照片不多',
    );
  });

  it('`profile` 匹配不到 → 整个组合区不渲染', () => {
    const html = render({ selection: { eraCode: 'E1', sceneId: 1, count: 2 } });
    expect(html).not.toContain('你选的组合');
    expect(html).not.toContain('visualSignature');
  });
});

describe('提交按钮的置灰（§7、P00 §12：置灰且不发起 POST）', () => {
  it('未选年代 → 置灰 + 「上面先各选一个」', () => {
    const html = render({ selection: { eraCode: null, sceneId: 1, count: 2 } });
    expect(html).toContain('disabled');
    expect(html).toContain('上面先各选一个');
  });

  it('未选场景 → 置灰 + 「上面先各选一个」', () => {
    const html = render({ selection: { eraCode: 'E2', sceneId: null, count: 2 } });
    expect(html).toContain('disabled');
    expect(html).toContain('上面先各选一个');
  });

  it('额度不足 → 置灰 +「今天的额度不够了」+「今天还能生成 1 张」', () => {
    const html = render({ remaining: 1 });
    expect(html).toContain('disabled');
    expect(html).toContain('今天的额度不够了');
    expect(html).toContain('今天还能生成 1 张');
  });

  it('选完且有额度 → 按钮可点、无置灰文案', () => {
    const html = render();
    expect(html).not.toContain('disabled');
    expect(html).toContain('开始生成');
    expect(html).not.toContain('上面先各选一个');
  });

  it('提交中 → 按钮置灰且换成「正在生成，大概要等一会儿」（不再重复原因行）', () => {
    const html = render({ busy: true });
    expect(html).toContain('disabled');
    expect(html.match(/正在生成，大概要等一会儿/g)).toHaveLength(1);
    expect(html).not.toContain('开始生成');
  });
});

describe('错误呈现（§8）', () => {
  it('提交失败走 `ErrorNotice` 的 inline 形态，主文案取服务端 message', () => {
    const html = render({ submitError: { code: 'QUOTA_EXCEEDED', message: '今天的生成额度用完了，明天再来吧' } });
    expect(html).toContain('今天的生成额度用完了，明天再来吧');
    expect(html).toContain('role="alert"');
  });
});
