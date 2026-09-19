'use client';

import type { ReactNode } from 'react';
import type { Generation } from '../../src/shared/types';
import { generationStatusNotice } from '../../src/shared/result';

/**
 * 部分成功 / 失败说明（`docs/prd/pages/P03-结果历史与下载.md` §6）：
 * `partial` → `这几张只成功了一部分`（成功的结果照常展示、不隐藏）；
 * `failed` → `这次没生成出来` + 服务端 `error.message`（`spec/03-接口契约.md` §5 是文案唯一事实源，
 * 本组件只展示、不复述）。
 *
 * 不出现倒计时、百分比与夸张成功提示（`pages/P00-设计基准与路由.md` §3.1、§9.3）。
 */
export interface PartialNoticeProps {
  status: Generation['status'];
  error: Generation['error'];
  onRetry: () => void;
}

export function PartialNotice({ status, error, onRetry }: PartialNoticeProps): ReactNode {
  const copy = generationStatusNotice(status);
  if (copy === null) return null;

  return (
    <div className="flex flex-col gap-sm rounded-md border border-border bg-surface px-xl py-lg animate-fade-in" role="status">
      <p className="text-note text-ink">{copy}</p>
      {status === 'failed' && error !== null ? <p className="text-note text-ink-soft">{error.message}</p> : null}
      <div>
        <button type="button" onClick={onRetry} className="text-note text-primary underline">
          再试一次
        </button>
      </div>
    </div>
  );
}
