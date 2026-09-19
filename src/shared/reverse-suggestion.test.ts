import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptReverseSuggestion,
  resetReverseSuggestion,
  takeReverseSuggestion,
} from './reverse-suggestion';

/**
 * 反推推荐的内存态（`docs/prd/pages/P00-设计基准与路由.md` §6、`pages/P02-年代与场景选择.md` §7）：
 * 采纳写入 → 取用即清空；**不落任何存储**。
 */
beforeEach(() => {
  resetReverseSuggestion();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('adopt / take', () => {
  it('未写入时为 null', () => {
    expect(takeReverseSuggestion()).toBeNull();
  });

  it('取用后清空（第二次取到 null）', () => {
    adoptReverseSuggestion({ eraCode: 'E2', sceneId: 3 });

    expect(takeReverseSuggestion()).toEqual({ eraCode: 'E2', sceneId: 3 });
    expect(takeReverseSuggestion()).toBeNull();
  });

  it('再次写入覆盖上一次（采纳只是一次初值）', () => {
    adoptReverseSuggestion({ eraCode: 'E2', sceneId: 3 });
    adoptReverseSuggestion({ eraCode: null, sceneId: 5 });
    expect(takeReverseSuggestion()).toEqual({ eraCode: null, sceneId: 5 });
  });

  it('返回副本：调用方改不动内部状态', () => {
    adoptReverseSuggestion({ eraCode: 'E2', sceneId: 3 });
    const taken = takeReverseSuggestion();
    if (taken !== null) taken.eraCode = 'E4';

    adoptReverseSuggestion({ eraCode: 'E2', sceneId: 3 });
    expect(takeReverseSuggestion()).toEqual({ eraCode: 'E2', sceneId: 3 });
  });
});

describe('不落任何存储（P00 §6：刷新即丢）', () => {
  it('不触碰 localStorage / sessionStorage', () => {
    const setItem = vi.fn();
    const getItem = vi.fn();
    const removeItem = vi.fn();
    const storage = { setItem, getItem, removeItem } as unknown as Storage;
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);

    adoptReverseSuggestion({ eraCode: 'E2', sceneId: 3 });
    takeReverseSuggestion();
    resetReverseSuggestion();

    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});
