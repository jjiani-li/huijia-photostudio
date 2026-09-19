import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnchorFeatures } from '../../src/shared/types';
import { FEATURE_LABELS, FEATURE_TOGGLE_COPY } from './confirm-logic';
import { FeatureList } from './feature-list';

/**
 * 12 项特征的折叠列表（`docs/prd/pages/P01-上传与身份确认.md` §4.3）：默认折叠、
 * 两态标题逐字、展开后 12 项标签按序对应 `AnchorFeatures` 的键。
 */
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

const render = (open: boolean): string =>
  renderToStaticMarkup(<FeatureList features={FEATURES} open={open} onToggle={() => undefined} />);

describe('特征折叠区（§4.3）', () => {
  it('默认折叠态：标题写项数，12 项标签与值都不渲染', () => {
    const html = render(false);
    expect(html).toContain(FEATURE_TOGGLE_COPY.collapsed);
    expect(html).not.toContain(FEATURE_TOGGLE_COPY.expanded);
    expect(html).not.toContain('<dl');
    for (const { label, key } of FEATURE_LABELS) {
      expect(html).not.toContain(label);
      expect(html).not.toContain(FEATURES[key]);
    }
  });

  it('展开态：标题变「收起」，12 项标签与值按序出现', () => {
    const html = render(true);
    expect(html).toContain(FEATURE_TOGGLE_COPY.expanded);
    expect(html).not.toContain(FEATURE_TOGGLE_COPY.collapsed);
    expect(html.match(/<dt/g)).toHaveLength(12);

    let cursor = -1;
    for (const { label, key } of FEATURE_LABELS) {
      const at = html.indexOf(label);
      expect(at).toBeGreaterThan(cursor);
      expect(at).toBeLessThan(html.indexOf(FEATURES[key], at));
      cursor = at;
    }
  });

  it('展开态带 `aria-expanded`，属性随两态切换', () => {
    expect(render(true)).toContain('aria-expanded="true"');
    expect(render(false)).toContain('aria-expanded="false"');
  });
});
