'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ApiNotice } from '../src/shared/api-client';
import { isErrorCode } from '../src/shared/error-message';

/**
 * `ErrorNotice`（`docs/prd/pages/P00-设计基准与路由.md` §8）：`docs/prd/spec/03-接口契约.md` §5 错误码在
 * 前端的**唯一落点**。主文案**直接用服务端 `error.message`**（前端不重写）；未知 `code` → 按 `INTERNAL`。
 * worker 未存活提示不走这里（它不是 API 错误，见 `components/worker-notice.tsx`）。
 */
export interface ErrorNoticeProps {
  error: ApiNotice | null;
  /** `page` 占满内容区；`inline` 贴触发控件下方。缺省按错误码推导（同文档 §8 表）。 */
  variant?: 'inline' | 'page';
  /** 不传则不显示重试按钮。 */
  onRetry?: () => void;
  /** 附加动作插槽：「换一张」「去确认」「去看那一组」「去实名」。 */
  action?: ReactNode;
}

export interface ErrorShape {
  variant: 'inline' | 'page';
  retryable: boolean;
}

/** 未知 `code` 归 `INTERNAL`（§8）。 */
const PAGE_CODES = ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'ANCHOR_NOT_FOUND'];
const HISTORY_CODES = ['FORBIDDEN', 'NOT_FOUND', 'ANCHOR_NOT_FOUND'];
const RETRY_CODES = ['PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'STORAGE_ERROR', 'INTERNAL'];

export const errorShape = (code: string): ErrorShape => {
  const known = isErrorCode(code) ? code : 'INTERNAL';
  return { variant: PAGE_CODES.includes(known) ? 'page' : 'inline', retryable: RETRY_CODES.includes(known) };
};

export function ErrorNotice({ error, variant, onRetry, action }: ErrorNoticeProps): ReactNode {
  if (error === null) return null;
  const known = isErrorCode(error.code) ? error.code : 'INTERNAL';
  const shape = errorShape(error.code);
  const finalVariant = variant ?? shape.variant;
  const defaultAction =
    known === 'UNAUTHENTICATED' ? (
      <Link href="/login" className="text-note text-primary underline">
        去登录
      </Link>
    ) : HISTORY_CODES.includes(known) ? (
      <Link href="/history" className="text-note text-primary underline">
        回历史
      </Link>
    ) : null;
  const extra = action ?? defaultAction;

  return (
    <div
      role="alert"
      className={
        finalVariant === 'page'
          ? 'mx-auto w-full max-w-content rounded-md border border-danger bg-surface px-xl py-lg text-note animate-fade-in'
          : 'rounded-md border border-danger bg-surface px-lg py-md text-note animate-fade-in'
      }
    >
      <p className="text-danger">{error.message}</p>
      {(extra !== null && extra !== undefined) || (shape.retryable && onRetry !== undefined) ? (
        <div className="mt-md flex items-center gap-lg">
          {extra}
          {shape.retryable && onRetry !== undefined ? (
            <button type="button" onClick={onRetry} className="text-primary underline">
              重试
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
