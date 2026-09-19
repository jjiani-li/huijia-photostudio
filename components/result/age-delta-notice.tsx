'use client';

import type { ReactNode } from 'react';
import { ageDeltaNotice } from '../../src/shared/result';

/**
 * 年龄偏差提示（`docs/prd/pages/P03-结果历史与下载.md` §6、
 * `docs/prd/modules/M07-生成后复核与内容审核.md` §5.5）：仅当 `ageDelta !== null` 且 `|ageDelta| > 5`
 * 时出现；`null` 与阈值内一律不渲染（不显示推测性提示）。
 */
export function AgeDeltaNotice({ ageDelta }: { ageDelta: number | null }): ReactNode {
  const text = ageDeltaNotice(ageDelta);
  return text === null ? null : <p className="text-micro text-ink-soft">{text}</p>;
}
