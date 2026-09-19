import type { ReactNode } from 'react';

/**
 * 选项卡片的共同外壳（`docs/prd/pages/P02-年代与场景选择.md` §4）：年代卡与场景卡只差
 * 样片来源与标题行，选中态（`border-primary` + `bg-primary-soft`）与米杏底（`bg-surface`）
 * 是同一套，故外壳只此一份。整体是一个按钮，选中态用 `aria-pressed` 表达。
 */
export interface OptionCardProps {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}

export function OptionCard({ selected, onSelect, children }: OptionCardProps): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={
        selected
          ? 'flex flex-col gap-md rounded-md border border-primary bg-primary-soft p-lg text-left animate-fade-in'
          : 'flex flex-col gap-md rounded-md border border-border bg-surface p-lg text-left'
      }
    >
      {children}
    </button>
  );
}
