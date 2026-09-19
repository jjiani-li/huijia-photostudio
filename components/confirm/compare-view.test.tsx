import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Photo } from '../../src/shared/types';
import { CompareView } from './compare-view';
import { COMPARE_LABELS, PHOTO_PENDING_COPY } from './confirm-logic';

/**
 * 对比区（`docs/prd/pages/P01-上传与身份确认.md` §4.3、
 * `docs/prd/spec/06-合规与风控.md` §9.1）：两侧标签逐字、只用服务端 `url`、
 * **不得**出现任何暗示「变清楚了 / 被修过」的文案。
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

describe('对比区（§4.3）', () => {
  it('两侧标签逐字，左原图右预处理图', () => {
    const html = renderToStaticMarkup(
      <CompareView
        before={photo()}
        after={photo({ id: 13, kind: 'preprocessed', url: '/api/photos/13/file?w=800' })}
      />,
    );
    expect(html).toContain(COMPARE_LABELS.before);
    expect(html).toContain(COMPARE_LABELS.after);
    expect(html.indexOf(COMPARE_LABELS.before)).toBeLessThan(html.indexOf(COMPARE_LABELS.after));
  });

  it('只用响应里的 `url`，不构造路径', () => {
    const html = renderToStaticMarkup(
      <CompareView before={photo()} after={photo({ id: 13, url: '/api/photos/13/file?w=800' })} />,
    );
    expect(html).toContain('src="/api/photos/12/file?w=800"');
    expect(html).toContain('src="/api/photos/13/file?w=800"');
    expect(html).not.toContain('/storage/');
    expect(html).not.toContain('src="13"');
  });

  it('`preprocessedPhoto = null` → 右侧写占位，左侧照常出图', () => {
    const html = renderToStaticMarkup(<CompareView before={photo()} after={null} />);
    expect(html).toContain(PHOTO_PENDING_COPY);
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain(COMPARE_LABELS.after);
  });

  it('没有任何暗示「变清楚了 / 被修过」的标签或说明', () => {
    const html = renderToStaticMarkup(<CompareView before={photo()} after={photo({ id: 13 })} />);
    for (const banned of ['变清楚', '更清晰', '清晰', '修复', '修好', '增强', '预处理', '处理后', '超分', '美化']) {
      expect(html).not.toContain(banned);
    }
  });
});
