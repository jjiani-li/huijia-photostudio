import type { ReactNode } from 'react';
import type { SceneOption } from '../../src/shared/types';
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
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(scene.id)}
      className={
        selected
          ? 'flex flex-col gap-md rounded-md border border-primary bg-primary-soft p-lg text-left animate-fade-in'
          : 'flex flex-col gap-md rounded-md border border-border bg-surface p-lg text-left'
      }
    >
      <SampleSlot src={scene.coverUrl} caption={scene.caption} alt={scene.name} />
      <span className="font-serif text-heading text-ink">{scene.name}</span>
    </button>
  );
}
