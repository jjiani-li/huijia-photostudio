import type { ReactNode } from 'react';
import type { ApiNotice } from '../../src/shared/api-client';
import type { EraSceneConfig, EraSceneProfile } from '../../src/shared/types';
import { ErrorNotice } from '../error-notice';
import { ComboPreview } from './combo-preview';
import { CountPicker } from './count-picker';
import { EraCard } from './era-card';
import { GenerateCta } from './generate-cta';
import { SceneCard } from './scene-card';
import {
  disabledReason,
  generateGate,
  quotaHint,
  type Count,
  type Selection,
} from './selection';

/**
 * `/choose/[anchorId]` 的展示层（`docs/prd/pages/P02-年代与场景选择.md` §2 的组件树）。
 * **无状态、无取数**：选择来自 URL（由 `choose-panel.tsx` 读出来当 props 传进来），
 * 因此本组件可以被静态渲染逐条断言文案与置灰状态。
 */
export interface ChooseViewProps {
  config: EraSceneConfig;
  /** 已与配置表对过的选择（URL 里有但配置里没有的值在这里是 `null`）。 */
  selection: Selection;
  /** `GET /api/me` 的 `quota.remaining`；未取到为 `null`。 */
  remaining: number | null;
  busy: boolean;
  submitError: ApiNotice | null;
  onSelectEra: (code: string) => void;
  onSelectScene: (id: number) => void;
  onChangeCount: (count: Count) => void;
  onGenerate: () => void;
}

/** `(eraCode, sceneId)` 命中的组合档案；未命中返回 `null`（整个组合区不渲染）。 */
export const findProfile = (
  config: EraSceneConfig,
  selection: Selection,
): EraSceneProfile | null =>
  config.profiles.find(
    (profile) => profile.eraCode === selection.eraCode && profile.sceneId === selection.sceneId,
  ) ?? null;

export function ChooseView({
  config,
  selection,
  remaining,
  busy,
  submitError,
  onSelectEra,
  onSelectScene,
  onChangeCount,
  onGenerate,
}: ChooseViewProps): ReactNode {
  const era = config.eras.find((item) => item.code === selection.eraCode) ?? null;
  const scene = config.scenes.find((item) => item.id === selection.sceneId) ?? null;
  const profile = findProfile(config, selection);

  const gate = generateGate({ ...selection, remaining, busy });
  return (
    <section className="flex flex-col gap-2xl animate-fade-in">
      <header className="flex flex-col gap-sm">
        <h1 className="font-serif text-title text-ink">让他出现在哪个年代、哪个地方</h1>
        <p className="text-note text-ink-soft">先选年代，再选场景。两个都可以随时改。</p>
      </header>

      <section className="flex flex-col gap-lg">
        <h2 className="font-serif text-heading text-ink">先选年代</h2>
        <div className="grid gap-lg md:grid-cols-2">
          {config.eras.map((item) => (
            <EraCard key={item.code} era={item} selected={item.code === selection.eraCode} onSelect={onSelectEra} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-lg">
        <h2 className="font-serif text-heading text-ink">再选场景</h2>
        <div className="grid gap-lg md:grid-cols-2">
          {config.scenes.map((item) => (
            <SceneCard key={item.id} scene={item} selected={item.id === selection.sceneId} onSelect={onSelectScene} />
          ))}
        </div>
      </section>

      <ComboPreview
        eraName={era?.name ?? ''}
        sceneName={scene?.name ?? ''}
        profile={profile}
        confidenceHintThreshold={config.confidenceHintThreshold}
      />

      <CountPicker value={selection.count} onChange={onChangeCount} />

      <ErrorNotice error={submitError} variant="inline" />

      <GenerateCta
        disabled={gate !== null}
        reason={disabledReason({ ...selection, remaining, busy })}
        quotaHint={gate === 'quota' && remaining !== null ? quotaHint(remaining) : null}
        busy={busy}
        onGenerate={onGenerate}
      />
    </section>
  );
}

/**
 * 配置未回时的卡片骨架（`pages/P02` §8）：只有 `bg-surface` 色块，**没有**文字、
 * 没有图标、不渲染 `<img>`——样片「无样片」态的 `暂无示例` 是另一回事（§4）。
 */
export function ChooseSkeleton(): ReactNode {
  return (
    <div className="flex flex-col gap-2xl" aria-hidden="true">
      <div className="h-16 w-full rounded-md bg-surface animate-fade-in" />
      <div className="h-48 w-full rounded-md bg-surface animate-fade-in" />
      <div className="h-48 w-full rounded-md bg-surface animate-fade-in" />
    </div>
  );
}
