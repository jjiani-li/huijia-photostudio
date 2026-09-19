import type { ReactNode } from 'react';
import { CONSENT_SCOPES, type ConsentScope } from '../../src/shared/types';
import { CONSENT_COPY, CONSENT_FOOTNOTE_COPY } from './confirm-logic';

/**
 * 两项授权勾选（`docs/prd/pages/P01-上传与身份确认.md` §4.3；文案权威来源
 * `docs/prd/modules/M04-身份确认与授权.md` §10）：
 *
 * - 勾选态由调用方持有，**初始未勾选、绝不预勾选**、绝不写 URL / `localStorage` / `sessionStorage`；
 * - 复选框的 `name` 直接取 `scope` 值，两项**不得**合并成一个「全部同意」框；
 * - 下方小字默认可见、不可折叠；
 * - `details.fields.consents` 命中的项只**高亮**，不回显 `details` 原文（`pages/P00` §8）。
 */
export interface ConsentPanelProps {
  checked: Record<ConsentScope, boolean>;
  /** 要高亮的勾选项（`invalidConsentScopes` 的返回值）。 */
  invalid: readonly ConsentScope[];
  onChange: (scope: ConsentScope, checked: boolean) => void;
}

export function ConsentPanel({ checked, invalid, onChange }: ConsentPanelProps): ReactNode {
  return (
    <section className="flex flex-col gap-md">
      {CONSENT_SCOPES.map((scope) => (
        <label
          key={scope}
          className={`flex items-start gap-sm text-note ${invalid.includes(scope) ? 'text-danger' : 'text-ink'}`}
        >
          <input
            type="checkbox"
            name={scope}
            checked={checked[scope]}
            onChange={(event) => onChange(scope, event.target.checked)}
            className="mt-xs"
          />
          <span>{CONSENT_COPY[scope]}</span>
        </label>
      ))}
      <p className="text-micro text-ink-soft">{CONSENT_FOOTNOTE_COPY}</p>
    </section>
  );
}
