import type { ReactNode } from 'react';
import { GATE_COPY } from './selection';

/**
 * 发起生成（`docs/prd/pages/P02-年代与场景选择.md` §7）：置灰时**不发起**
 * `POST /api/generations`（该端点非幂等，`spec/03-接口契约.md` §1.5），按钮下方给出置灰原因。
 * 生成中按钮文案换 `正在生成，大概要等一会儿`，此时不再重复原因行。
 * 状态区带 `aria-live="polite"`（`pages/P00-设计基准与路由.md` §13）。
 */
export interface GenerateCtaProps {
  disabled: boolean;
  /** 置灰原因（`disabledReason` 的返回值）；可生成时为 `null`。 */
  reason: string | null;
  /** 额度不足时的第二行（`quotaHint`）；其余情况为 `null`。 */
  quotaHint: string | null;
  busy: boolean;
  onGenerate: () => void;
}

export function GenerateCta({ disabled, reason, quotaHint, busy, onGenerate }: GenerateCtaProps): ReactNode {
  return (
    <div className="flex flex-col items-start gap-sm" aria-live="polite">
      <button
        type="button"
        disabled={disabled}
        onClick={onGenerate}
        className={
          disabled
            ? 'rounded-pill bg-primary-soft px-2xl py-md text-body text-ink-soft'
            : 'rounded-pill bg-primary px-2xl py-md text-body text-background'
        }
      >
        {busy ? GATE_COPY.busy : '开始生成'}
      </button>
      {reason !== null && !busy ? <p className="text-note text-ink-soft">{reason}</p> : null}
      {quotaHint !== null ? <p className="text-note text-ink-soft">{quotaHint}</p> : null}
    </div>
  );
}
