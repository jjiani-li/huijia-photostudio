import type { ReactNode } from 'react';
import type { EraOption } from '../../src/shared/types';
import { OptionCard } from './option-card';
import { SampleSlot } from './sample-slot';

/**
 * 年代卡片（`docs/prd/pages/P02-年代与场景选择.md` §4、§7）：样片位 + 卡片名 +
 * `isMono` 时的「黑白」标记。
 */
export interface EraCardProps {
  era: EraOption;
  selected: boolean;
  onSelect: (code: string) => void;
}

export function EraCard({ era, selected, onSelect }: EraCardProps): ReactNode {
  return (
    <OptionCard selected={selected} onSelect={() => onSelect(era.code)}>
      <SampleSlot src={era.sampleUrl} caption={era.caption} alt={era.name} />
      <span className="flex items-center gap-sm">
        <span className="font-serif text-heading text-ink">{era.name}</span>
        {era.isMono ? <span className="text-micro text-ink-soft">黑白</span> : null}
      </span>
    </OptionCard>
  );
}
