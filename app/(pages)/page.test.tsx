import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import HomePage from './page';

/** 首页是公开页，只渲染静态文案；`UploadEntry` 需要 App Router 的 hooks，测试里换成空实现。 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => '/',
}));

describe('/ 首页（docs/prd/pages/P01-上传与身份确认.md §4.1）', () => {
  it('标题 / 一句话说明 / 上传入口 / 页脚两行逐字对齐', () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html).toContain('回家照相馆');
    expect(html).toContain('上传一张老照片，让他出现在一张从没拍过的新照片里。');
    expect(html).toContain('上传一张老照片');
    expect(html).toContain('生成的是新照片，不是把旧照片修清楚。');
    expect(html).toContain('AI 生成，仅供家人留存。');
  });
});
