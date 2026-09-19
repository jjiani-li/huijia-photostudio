import type { ReactNode } from 'react';
import { COUNTS, type Count } from './selection';

/**
 * 张数选择（`docs/prd/pages/P02-年代与场景选择.md` §7）：2 / 3 / 4 张，默认 2 张。
 * 逐字文案 `生成几张` 与 `2 张` `3 张` `4 张`。
 */
export interface CountPickerProps {
  value: Count;
  onChange: (count: Count) => void;
}

export function CountPicker({ value, onChange }: CountPickerProps): ReactNode {
  return (
    <div className="flex items-center gap-lg">
      <span className="text-note text-ink-soft">生成几张</span>
      <div className="flex items-center gap-sm">
        {COUNTS.map((count) => (
          <button
            key={count}
            type="button"
            aria-pressed={value === count}
            onClick={() => onChange(count)}
            className={
              value === count
                ? 'rounded-pill border border-primary bg-primary-soft px-lg py-sm text-note text-ink'
                : 'rounded-pill border border-border bg-surface px-lg py-sm text-note text-ink-soft'
            }
          >
            {count} 张
          </button>
        ))}
      </div>
    </div>
  );
}
