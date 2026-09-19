import type { ReactNode } from 'react';
import type { EraOption } from '../../src/shared/types';
import { SampleSlot } from './sample-slot';

/**
 * 年代卡片（`docs/prd/pages/P02-年代与场景选择.md` §4、§7）：样片位 + 卡片名 +
 * `isMono` 时的「黑白」标记。整体是一个按钮（选中态用 `aria-pressed` 与描边表达）。
 */
export interface EraCardProps {
  era: EraOption;
  selected: boolean;
  onSelect: (code: string) => void;
}

export function EraCard({ era, selected, onSelect }: EraCardProps): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(era.code)}
      className={
        selected
          ? 'flex flex-col gap-md rounded-md border border-primary bg-primary-soft p-lg text-left animate-fade-in'
          : 'flex flex-col gap-md rounded-md border border-border bg-surface p-lg text-left'
      }
    >
      <SampleSlot src={era.sampleUrl} caption={era.caption} alt={era.name} />
      <span className="flex items-center gap-sm">
        <span className="font-serif text-heading text-ink">{era.name}</span>
        {era.isMono ? <span className="text-micro text-ink-soft">黑白</span> : null}
      </span>
    </button>
  );
}
