'use client';

import type { ReactNode } from 'react';
import { EXTRACT_COPY } from './uploads';

/**
 * 发起锚点提取（`docs/prd/pages/P01-上传与身份确认.md` §4.2）：置灰时**不发起** `POST /api/anchors`
 * （该端点非幂等，`spec/03-接口契约.md` §1.5）；请求在途保持置灰，避免重复建行。
 * 状态区带 `aria-live="polite"`（`pages/P00-设计基准与路由.md` §13）。
 */
export interface ExtractCtaProps {
  disabled: boolean;
  /** `POST /api/anchors` 在途。 */
  busy: boolean;
  onClick: () => void;
}

export function ExtractCta({ disabled, busy, onClick }: ExtractCtaProps): ReactNode {
  const blocked = disabled || busy;
  return (
    <div className="flex flex-col items-start gap-sm" aria-live="polite">
      <button
        type="button"
        disabled={blocked}
        onClick={onClick}
        className={
          blocked
            ? 'rounded-pill bg-primary-soft px-2xl py-md text-body text-ink-soft'
            : 'rounded-pill bg-primary px-2xl py-md text-body text-background'
        }
      >
        {EXTRACT_COPY}
      </button>
    </div>
  );
}
