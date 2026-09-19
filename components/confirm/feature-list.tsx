import type { ReactNode } from 'react';
import type { AnchorFeatures } from '../../src/shared/types';
import { FEATURE_LABELS, FEATURE_TOGGLE_COPY } from './confirm-logic';

/**
 * 12 项特征的可折叠列表（`docs/prd/pages/P01-上传与身份确认.md` §4.3）：默认折叠，展开态由
 * 调用方持有（`pages/P00-设计基准与路由.md` §6：跨组件共享的都是 `useState`，不落存储），
 * 本组件因此无状态、可静态渲染断言两态文案。
 *
 * `features = null` 时整个折叠区不渲染——该判据在 `confirm-view.tsx`（`pages/P01` §4.3 的边界）。
 */
export interface FeatureListProps {
  features: AnchorFeatures;
  open: boolean;
  onToggle: () => void;
}

export function FeatureList({ features, open, onToggle }: FeatureListProps): ReactNode {
  return (
    <section className="flex flex-col gap-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="self-start text-note text-primary underline"
      >
        {open ? FEATURE_TOGGLE_COPY.expanded : FEATURE_TOGGLE_COPY.collapsed}
      </button>
      {open ? (
        <dl className="grid gap-sm rounded-md bg-surface px-xl py-lg md:grid-cols-2">
          {FEATURE_LABELS.map(({ key, label }) => (
            <div key={key} className="flex gap-sm">
              <dt className="text-note text-ink-soft">{label}</dt>
              <dd className="text-note text-ink">{features[key]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
