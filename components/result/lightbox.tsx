'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { GenerationResult } from '../../src/shared/types';

/**
 * 放大查看（`docs/prd/pages/P03-结果历史与下载.md` §6）：`←` / `→` 切换、`Esc` 或点空白关闭。
 * 只做展示，不提供下载与反馈（那在结果卡上）——避免同一动作两处入口。
 */
export interface LightboxProps {
  results: GenerationResult[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}

export function Lightbox({ results, index, onClose, onIndexChange }: LightboxProps): ReactNode {
  const total = results.length;

  useEffect(() => {
    if (total === 0) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') onIndexChange((index - 1 + total) % total);
      if (event.key === 'ArrowRight') onIndexChange((index + 1) % total);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [index, total, onClose, onIndexChange]);

  const current = results[index];
  if (current === undefined) return null;

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center gap-lg bg-ink/80 p-xl animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="放大查看"
      onClick={onClose}
    >
      <img
        src={current.url}
        alt={`第 ${index + 1} 张`}
        className="max-h-[70vh] w-auto rounded-lg"
        onClick={(event) => event.stopPropagation()}
      />
      <div className="flex items-center gap-lg">
        <button type="button" onClick={() => onIndexChange((index - 1 + results.length) % results.length)} className="text-note text-background">
          上一张
        </button>
        <button type="button" onClick={onClose} className="text-note text-background">
          关闭
        </button>
        <button type="button" onClick={() => onIndexChange((index + 1) % results.length)} className="text-note text-background">
          下一张
        </button>
      </div>
    </div>
  );
}
