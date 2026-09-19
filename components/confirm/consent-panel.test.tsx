import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConsentScope } from '../../src/shared/types';
import { ConsentPanel } from './consent-panel';
import {
  CONSENT_COPY,
  CONSENT_FOOTNOTE_COPY,
  CONSENT_INCOMPLETE_COPY,
  UNCHECKED_CONSENTS,
} from './confirm-logic';

/**
 * 授权勾选区（`docs/prd/pages/P01-上传与身份确认.md` §4.3、
 * `docs/prd/modules/M04-身份确认与授权.md` §10）：两句文案逐字、`name` 取 `scope`、
 * 初始不预勾选、小字常驻、缺失项只高亮不展示 `details` 原文。
 */
const render = (over: {
  checked?: Record<ConsentScope, boolean>;
  invalid?: ConsentScope[];
} = {}): string =>
  renderToStaticMarkup(
    <ConsentPanel checked={over.checked ?? UNCHECKED_CONSENTS} invalid={over.invalid ?? []} onChange={() => undefined} />,
  );

describe('授权勾选区（M04 §10）', () => {
  it('两句文案逐字、两项分开，`name` 取 scope', () => {
    const html = render();
    expect(html).toContain(CONSENT_COPY.photo_usage);
    expect(html).toContain(CONSENT_COPY.family_agreement);
    expect(html).toContain('name="photo_usage"');
    expect(html).toContain('name="family_agreement"');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  });

  it('初始两个框都未勾选（渲染里没有 checked 属性）', () => {
    expect(render()).not.toContain('checked');
  });

  it('勾选态逐项反映，不互相牵连', () => {
    expect(render({ checked: { photo_usage: true, family_agreement: false } }).match(/checked=""/g)).toHaveLength(1);
    expect(render({ checked: { photo_usage: true, family_agreement: true } }).match(/checked=""/g)).toHaveLength(2);
  });

  it('下方小字常驻且不可折叠（没有 details / open / 收起）', () => {
    const html = render();
    expect(html).toContain(CONSENT_FOOTNOTE_COPY);
    expect(html).not.toContain('<details');
    expect(html).not.toContain('收起');
  });

  it('命中的勾选项高亮（danger 色），未命中的不高亮', () => {
    const html = render({ invalid: ['family_agreement'] });
    expect(html.match(/text-danger/g)).toHaveLength(1);
    expect(html.indexOf('text-danger')).toBeGreaterThan(html.indexOf(CONSENT_COPY.photo_usage));
  });

  it('不出现「同意以上全部」这类合并框，也没有未勾满提示（提示归主按钮）', () => {
    const html = render();
    expect(html).not.toContain('全部');
    expect(html).not.toContain(CONSENT_INCOMPLETE_COPY);
  });
});
