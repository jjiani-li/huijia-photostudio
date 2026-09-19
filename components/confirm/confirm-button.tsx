import type { ReactNode } from 'react';
import { CONFIRM_BUTTON_COPY } from './confirm-logic';

/**
 * 主按钮的样式（`docs/prd/pages/P01-上传与身份确认.md` §4.3）：`确认` 与已确认后的
 * `去选年代和场景` 共用同一形态（后者是 `next/link` 的路由跳转）。
 */
export const PRIMARY_ACTION_CLASS =
  'inline-block rounded-pill bg-primary px-xl py-md text-note text-background disabled:bg-primary-soft disabled:text-ink-soft';

/**
 * 确认按钮（`docs/prd/pages/P01-上传与身份确认.md` §4.3）：未勾满两项时置灰，
 * `POST /api/anchors/:id/confirm` **非幂等**（`docs/prd/spec/03-接口契约.md` §1.5），
 * 请求期间一并禁用（`busy`）。
 */
export interface ConfirmButtonProps {
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}

export function ConfirmButton({ disabled, busy, onClick }: ConfirmButtonProps): ReactNode {
  return (
    <button type="button" disabled={disabled || busy} onClick={onClick} className={PRIMARY_ACTION_CLASS}>
      {CONFIRM_BUTTON_COPY}
    </button>
  );
}
