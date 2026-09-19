import { describe, expect, it } from 'vitest';
import type { EraCheck } from './types';
import { downloadFileName, eraCheckBadge, FEEDBACK_OPTIONS, nextFeedback, ageDeltaNotice } from './result';

/**
 * 结果页 / 历史页的纯函数（`docs/prd/pages/P03-结果历史与下载.md` §10）：
 * 年代徽标三态穷尽、年龄偏差仅 `|x| > 5`、下载文件名、反馈三态。
 */
const check = (verdict: EraCheck['verdict']): EraCheck => ({
  passed: verdict === 'pass',
  verdict,
  findings: [],
  model: null,
});

describe('eraCheckBadge（§10：三态互不相同且穷尽）', () => {
  it('review / reject / null 三态各有文案', () => {
    expect(eraCheckBadge(check('review'))).toBe('可能不符合所选年代，仅供参考');
    expect(eraCheckBadge(check('reject'))).toBe('明显不符合所选年代');
    expect(eraCheckBadge(null)).toBe('还没检查');
  });

  it('三态文案互不相同', () => {
    const labels = [eraCheckBadge(check('review')), eraCheckBadge(check('reject')), eraCheckBadge(null)];
    expect(new Set(labels).size).toBe(3);
  });

  it('pass 不渲染标注（null）', () => {
    expect(eraCheckBadge(check('pass'))).toBeNull();
  });

  it('pass 以外的 verdict 都有文案，没有漏网状态', () => {
    for (const verdict of ['pass', 'review', 'reject'] as const) {
      expect(eraCheckBadge(check(verdict)) !== undefined).toBe(true);
    }
  });
});

describe('ageDeltaNotice（§10：仅 |x| > 5）', () => {
  it('负数是变年轻，正数是年长（M07 §5.4 的有符号口径）', () => {
    expect(ageDeltaNotice(-8)).toBe('看起来比原照片年轻了 8 岁');
    expect(ageDeltaNotice(8)).toBe('看起来比原照片年长 8 岁');
  });

  it('边界 5 / -5 不提示，6 / -6 提示', () => {
    expect(ageDeltaNotice(5)).toBeNull();
    expect(ageDeltaNotice(-5)).toBeNull();
    expect(ageDeltaNotice(6)).toBe('看起来比原照片年长 6 岁');
    expect(ageDeltaNotice(-6)).toBe('看起来比原照片年轻了 6 岁');
  });

  it('0 与 null 不提示', () => {
    expect(ageDeltaNotice(0)).toBeNull();
    expect(ageDeltaNotice(null)).toBeNull();
  });
});

describe('downloadFileName（§6、§10）', () => {
  it('命名与 0 基序号：ordinal + 1', () => {
    expect(downloadFileName('更早的从前', '老屋院子', 0, 'png')).toBe('回家照相馆-更早的从前-老屋院子-1.png');
    expect(downloadFileName('更早的从前', '老屋院子', 2, 'png')).toBe('回家照相馆-更早的从前-老屋院子-3.png');
  });

  it('扩展名从 outputFormat 派生：jpeg → jpg，png → png', () => {
    expect(downloadFileName('E', 'S', 0, 'jpeg')).toMatch(/\.jpg$/);
    expect(downloadFileName('E', 'S', 0, 'png')).toMatch(/\.png$/);
  });
});

describe('nextFeedback（§6：再点同一按钮传 null）', () => {
  it('三个值互斥：点另一个值改写', () => {
    expect(nextFeedback(null, 1)).toBe(1);
    expect(nextFeedback(-1, 1)).toBe(1);
    expect(nextFeedback(1, -2)).toBe(-2);
  });

  it('点同一个值 → null（取消）', () => {
    expect(nextFeedback(1, 1)).toBeNull();
    expect(nextFeedback(-1, -1)).toBeNull();
    expect(nextFeedback(-2, -2)).toBeNull();
  });

  it('按钮文案与取值一一对应', () => {
    expect(FEEDBACK_OPTIONS.map((o) => o.label)).toEqual(['喜欢', '不喜欢', '不像他']);
    expect(FEEDBACK_OPTIONS.map((o) => o.value)).toEqual([1, -1, -2]);
  });
});
