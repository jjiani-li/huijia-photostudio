'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  markSafetyNoticeShown,
  SAFETY_NOTICE_TEXT,
  shouldShowSafetyNotice,
} from '../../src/shared/safety-notice';

/**
 * 首次情感安全提示（`docs/prd/pages/P03-结果历史与下载.md` §6、
 * `pages/P04-失败与情绪安全路径.md` §4、`docs/prd/spec/06-合规与风控.md` §9.2、检查项 `CMP-06`）：
 * 每会话一次、状态只放模块级内存态；它**不是** API 错误，不并入 `ErrorNotice`，也不是进度态。
 */

/** 展示用的语义句（纯展示、无副作用，便于静态断言）。 */
export function SafetyNoticeBody(): ReactNode {
  return (
    <p className="rounded-md bg-surface px-lg py-md text-note text-ink animate-fade-in">{SAFETY_NOTICE_TEXT}</p>
  );
}

/**
 * 自管理会话态的容器：首次进入 `/result/[generationId]` 时展示一次并标记已展示。
 * 标记放在 `useEffect`（只在浏览器执行）——服务端渲染期间模块内存在进程级共享，不能在渲染期标记。
 */
export function SafetyNotice(): ReactNode {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!shouldShowSafetyNotice()) return;
    markSafetyNoticeShown();
    setVisible(true);
  }, []);

  return visible ? <SafetyNoticeBody /> : null;
}
