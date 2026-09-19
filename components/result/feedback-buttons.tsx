'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import type { GenerationResult } from '../../src/shared/types';
import { FEEDBACK_OPTIONS, nextFeedback, type FeedbackValue } from '../../src/shared/result';

/**
 * 结果卡的三态反馈（`docs/prd/pages/P03-结果历史与下载.md` §6、
 * `pages/P04-失败与情绪安全路径.md` §5）：`1` / `-1` / `-2`（喜欢 / 不喜欢 / 不像他），
 * 再点同一按钮传 `null` 取消，请求期间该按钮禁用。
 *
 * `不像他` 是**对这张图**的失败信号：除落库外还给一条 `换一张照片再来` → `/upload`
 * （与重新生成、换输入重来的分界见 `pages/P04` §5）。
 */
export interface FeedbackButtonsProps {
  resultId: number;
  userFeedback: GenerationResult['userFeedback'];
  /** 该结果有反馈请求在飞行中：三个按钮全部禁用。 */
  pending: boolean;
  onFeedback: (resultId: number, feedback: FeedbackValue | null) => void;
}

export function FeedbackButtons({ resultId, userFeedback, pending, onFeedback }: FeedbackButtonsProps): ReactNode {
  return (
    <div className="flex flex-col gap-sm">
      <div className="flex items-center gap-sm">
        {FEEDBACK_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            disabled={pending}
            aria-pressed={userFeedback === value}
            onClick={() => onFeedback(resultId, nextFeedback(userFeedback, value))}
            className={
              userFeedback === value
                ? 'rounded-pill border border-primary bg-primary-soft px-lg py-sm text-note text-ink disabled:text-ink-soft'
                : 'rounded-pill border border-border px-lg py-sm text-note text-ink-soft hover:text-ink disabled:text-ink-soft'
            }
          >
            {label}
          </button>
        ))}
      </div>
      {userFeedback === -2 ? (
        <Link href="/upload" className="text-note text-primary underline">
          换一张照片再来
        </Link>
      ) : null}
    </div>
  );
}
