import type { ReactNode } from 'react';

/**
 * 样片的**两种状态**的唯一实现点（`docs/prd/pages/P02-年代与场景选择.md` §4、`pages/P00` §3.5）：
 * 年代卡、场景卡、组合预览三处共用。
 *
 * - 有样片（`src !== null`）：4:3 容器 + `<img>`，图下一行 `caption` 原样展示；
 * - 无样片（`null`）：**不渲染 `<img>`、不渲染任何占位图/灰框图/骨架图**，同高区块居中写 `暂无示例`。
 *
 * `seed-v1` 下样片全为 `null`（`spec/08-本地开发指南.md` §7），故本期一律走无样片态。
 */
export interface SampleSlotProps {
  src: string | null;
  caption: string;
  alt: string;
}

export function SampleSlot({ src, caption, alt }: SampleSlotProps): ReactNode {
  return (
    <figure className="flex w-full flex-col gap-sm">
      <div
        className={
          src === null
            ? 'flex aspect-[4/3] w-full items-center justify-center rounded-lg bg-surface'
            : 'aspect-[4/3] w-full overflow-hidden rounded-lg bg-surface shadow-soft'
        }
      >
        {src === null ? (
          <span className="text-note text-ink-soft">暂无示例</span>
        ) : (
          <img src={src} alt={alt} className="h-full w-full object-cover" />
        )}
      </div>
      <figcaption className="text-note text-ink-soft">{caption}</figcaption>
    </figure>
  );
}
