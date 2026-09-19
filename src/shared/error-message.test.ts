import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE, errorMessageOf, isErrorCode } from './error-message';
import { ERROR_CODES } from './types';

describe('errorMessageOf（docs/prd/spec/03-接口契约.md §5 的唯一代码侧镜像）', () => {
  it('穷尽 src/shared/types.ts 的全部 ErrorCode，且每条非空', () => {
    expect([...Object.keys(ERROR_MESSAGE)].sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(errorMessageOf(code)).toBe(ERROR_MESSAGE[code]);
      expect(errorMessageOf(code).length).toBeGreaterThan(0);
    }
  });

  it('逐字对照 spec/03-接口契约.md §5 的用户可见文案（抽检）', () => {
    expect(errorMessageOf('UNAUTHENTICATED')).toBe('请先登录');
    expect(errorMessageOf('FILE_TOO_LARGE')).toBe('这张照片太大了，换一张小一点的');
    expect(errorMessageOf('ANCHOR_NOT_CONFIRMED')).toBe('需要先确认"这就是他"，才能开始生成');
    expect(errorMessageOf('CONTENT_REJECTED')).toBe('这张照片暂时无法处理');
  });

  it('认不出的 code → 兜底 INTERNAL（与 ErrorNotice 同口径）', () => {
    expect(errorMessageOf('NOT_A_REAL_CODE')).toBe(ERROR_MESSAGE.INTERNAL);
    expect(isErrorCode('NOT_A_REAL_CODE')).toBe(false);
    expect(isErrorCode('INTERNAL')).toBe(true);
  });
});
