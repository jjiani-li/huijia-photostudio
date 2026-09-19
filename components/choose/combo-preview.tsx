import type { ReactNode } from 'react';
import type { EraSceneProfile } from '../../src/shared/types';
import { isLowConfidence } from './selection';
import { SampleSlot } from './sample-slot';

/**
 * 组合预览（`docs/prd/pages/P02-年代与场景选择.md` §4、§5）：`(eraCode, sceneId)` 命中档案才渲染，
 * 命中不到时**整个预览区不渲染**。样片位走 `profile.sampleUrl`，图下一行是 `visualSignature`；
 * 低置信（`confidence < confidenceHintThreshold`）时在它下方加一行温和提示，**不禁用、不拦截**。
 */
export interface ComboPreviewProps {
  eraName: string;
  sceneName: string;
  profile: EraSceneProfile | null;
  confidenceHintThreshold: number;
}

export function ComboPreview({
  eraName,
  sceneName,
  profile,
  confidenceHintThreshold,
}: ComboPreviewProps): ReactNode {
  if (profile === null) return null;
  const title = `${eraName} × ${sceneName}`;

  return (
    <section className="flex flex-col gap-md rounded-md border border-border bg-surface p-xl">
      <h2 className="font-serif text-heading text-ink">你选的组合</h2>
      <p className="text-note text-ink-soft">{title}</p>
      <SampleSlot src={profile.sampleUrl} caption={profile.visualSignature} alt={title} />
      {isLowConfidence(profile, confidenceHintThreshold) ? (
        <p className="text-note text-ink-soft">这两样配在一起的老照片不多，出来可能不太像那个年代。</p>
      ) : null}
    </section>
  );
}
