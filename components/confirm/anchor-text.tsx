import type { ReactNode } from 'react';

/**
 * 锚点文本（`docs/prd/pages/P01-上传与身份确认.md` §4.3）：服务端读出来的那段描述**原样展示**，
 * 前端不改写、不截断、不翻译。
 */
export interface AnchorTextProps {
  text: string;
}

export function AnchorText({ text }: AnchorTextProps): ReactNode {
  return (
    <section className="rounded-md bg-surface px-xl py-lg">
      <p className="text-body text-ink">{text}</p>
    </section>
  );
}
