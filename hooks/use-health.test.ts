import { describe, expect, it } from 'vitest';
import { shouldShowWorkerNotice } from './use-health';

/** 上传页顶部未存活提示的判据（`docs/prd/pages/P00-设计基准与路由.md` §4.2、`ERR-04`）。 */
describe('shouldShowWorkerNotice', () => {
  it('worker.alive === false → 显示', () => {
    expect(shouldShowWorkerNotice({ workerAlive: false })).toBe(true);
  });

  it('alive 为 true 或未知（null）→ 不显示', () => {
    expect(shouldShowWorkerNotice({ workerAlive: true })).toBe(false);
    expect(shouldShowWorkerNotice({ workerAlive: null })).toBe(false);
  });
});
