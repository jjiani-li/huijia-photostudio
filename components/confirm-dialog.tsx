'use client';

import type { ReactNode } from 'react';

/**
 * 二次确认弹层（`docs/prd/pages/P03-结果历史与下载.md` §8、`pages/P00-设计基准与路由.md` §8）：
 * 两级删除与「没走完的照片」区块共用**同一个**组件；标题 / 正文 / 按钮文案由调用方逐字传入
 * （三处的确认文案见 `pages/P03` §7–§8），本组件只管形态与禁用态。
 *
 * 删除类文案的**硬要求**：确认与成功提示都必须写明「删了拿不回来」，不得出现「可以恢复」
 * 「回收站」「过几天还能找回」（`pages/P03` §8）。
 */
export interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 请求进行中：两个按钮都禁用（`DELETE` 虽幂等，但避免重复提交）。 */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactNode {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="rounded-md border border-border bg-surface px-xl py-lg shadow-card animate-fade-in"
    >
      <p className="font-serif text-heading text-ink">{title}</p>
      <p className="mt-sm text-note text-ink-soft">{body}</p>
      <div className="mt-lg flex items-center gap-lg">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="rounded-pill bg-primary px-lg py-sm text-note text-background disabled:bg-primary-soft disabled:text-ink-soft"
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-pill border border-border px-lg py-sm text-note text-ink disabled:text-ink-soft"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
