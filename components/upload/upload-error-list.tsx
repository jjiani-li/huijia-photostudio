'use client';

import type { ReactNode } from 'react';
import { RETRY_UPLOAD_COPY, type UploadErrorRow } from './uploads';

/**
 * 上传 / 预处理失败的行（`docs/prd/pages/P01-上传与身份确认.md` §4.2 的 `UploadErrorList`）：
 * 主文案**取服务端 `error.message` 原样展示**（`spec/03-接口契约.md` §1.3；本页不复述文案，
 * 前端只在没有 envelope 的网络级失败上用 `src/shared/error-message.ts` 兜底），每行一个 `重试上传`，
 * 其余张不受影响。
 */
export interface UploadErrorListProps {
  rows: readonly UploadErrorRow[];
  onRetry: (key: string) => void;
}

export function UploadErrorList({ rows, onRetry }: UploadErrorListProps): ReactNode {
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-sm">
      {rows.map((row) => (
        <li
          key={row.key}
          className="flex flex-col gap-sm rounded-md border border-danger bg-surface px-lg py-md animate-fade-in"
        >
          <p className="text-note text-ink">{row.fileName}</p>
          <p className="text-note text-danger">{row.message}</p>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => onRetry(row.key)}
              className="text-note text-primary underline"
            >
              {RETRY_UPLOAD_COPY}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
