import type { ReactNode } from 'react';
import type { SceneOption } from '../../src/shared/types';
import { OptionCard } from './option-card';
import { SampleSlot } from './sample-slot';

/**
 * 场景卡片（`docs/prd/pages/P02-年代与场景选择.md` §4）：样片位取自 `scenes[].coverUrl`，
 * 卡片名取 `name`，说明取 `caption` 原样。
 */
export interface SceneCardProps {
  scene: SceneOption;
  selected: boolean;
  onSelect: (id: number) => void;
}

export function SceneCard({ scene, selected, onSelect }: SceneCardProps): ReactNode {
  return (
    <OptionCard selected={selected} onSelect={() => onSelect(scene.id)}>
      <SampleSlot src={scene.coverUrl} caption={scene.caption} alt={scene.name} />
      <span className="font-serif text-heading text-ink">{scene.name}</span>
    </OptionCard>
  );
}
