'use client';

import type { ReactNode } from 'react';
import type { Generation } from '../../src/shared/types';

/**
 * 结果页页头（`docs/prd/pages/P03-结果历史与下载.md` §6）：
 * `{eraName} · {sceneName}` + `共 {requestedCount} 张`。
 * 只展示 `eraName` / `sceneName` / `requestedCount` / `status`，
 * **不展示** `prompt` / `templateVersion` / `params.provider` / `realismScore` / `seed`（`pages/P03` §2）。
 */
export interface GenerationHeaderProps {
  generation: Generation;
}

export function GenerationHeader({ generation }: GenerationHeaderProps): ReactNode {
  return (
    <header className="flex flex-col gap-sm">
      <h1 className="font-serif text-title text-ink">
        {generation.eraName} · {generation.sceneName}
      </h1>
      <p className="text-micro text-ink-soft">共 {generation.requestedCount} 张</p>
    </header>
  );
}
