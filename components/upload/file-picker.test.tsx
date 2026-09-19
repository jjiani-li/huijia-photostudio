import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilePicker } from './file-picker';

/**
 * 文件选择器（`docs/prd/pages/P01-上传与身份确认.md` §4.2）：原生 input + 按钮，
 * `accept` 只列四种格式，`multiple` 允许多选。前端不预判大小与类型——
 * 那两条由服务端回 `INVALID_FILE_TYPE` / `FILE_TOO_LARGE`。
 */
describe('FilePicker', () => {
  it('多选 + `accept` 四格式 + 按钮文案', () => {
    const html = renderToStaticMarkup(
      <FilePicker multiple accept="image/jpeg,image/png,image/webp,image/heic" onPick={() => undefined} />,
    );
    expect(html).toContain('type="file"');
    expect(html).toContain('multiple');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp,image/heic"');
    expect(html).toContain('选照片');
    expect(html).not.toContain('disabled');
  });

  it('禁用时不渲染可点的按钮文案之外的东西（按钮带 disabled）', () => {
    const html = renderToStaticMarkup(<FilePicker multiple accept="image/png" disabled onPick={() => undefined} />);
    expect(html).toContain('disabled');
  });

  it('单张模式不写 `multiple`', () => {
    const html = renderToStaticMarkup(<FilePicker multiple={false} accept="image/png" onPick={() => undefined} />);
    expect(html).not.toContain('multiple');
  });
});
