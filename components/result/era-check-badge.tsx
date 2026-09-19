'use client';

import type { ReactNode } from 'react';
import type { EraCheck } from '../../src/shared/types';
import { eraCheckBadge } from '../../src/shared/result';

/**
 * 年代复核标注（`docs/prd/pages/P03-结果历史与下载.md` §6、
 * `docs/prd/modules/M07-生成后复核与内容审核.md` §5.3）：**只标注不阻断**——
 * 年代复核判定为 `reject` 的结果图不隐藏、不阻断下载。
 *
 * 三态：`review` / `reject` 出标注并在展开时列出 `findings`；`eraCheck === null` 只显示「还没检查」，
 * **不显示推测性提示**；`pass` 不渲染（`pages/P03` §6 的边界）。
 */
export function EraCheckBadge({ eraCheck }: { eraCheck: EraCheck | null }): ReactNode {
  const label = eraCheckBadge(eraCheck);
  if (label === null) return null;
  const findings = eraCheck?.findings ?? [];

  return (
    <div className="flex flex-col gap-xs">
      <p className="text-micro text-ink-soft">{label}</p>
      {findings.length > 0 ? (
        <ul className="flex flex-col gap-xs text-micro text-ink-soft">
          {findings.map((finding, i) => (
            <li key={i}>
              {finding.item}：{finding.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
