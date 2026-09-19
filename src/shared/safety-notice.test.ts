import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markSafetyNoticeShown,
  resetSafetyNotice,
  SAFETY_NOTICE_TEXT,
  shouldShowSafetyNotice,
} from './safety-notice';

/**
 * 情感安全提示的会话态（`docs/prd/pages/P04-失败与情绪安全路径.md` §4、
 * `docs/prd/spec/06-合规与风控.md` §9.2、检查项 `CMP-06`）：每会话一次、模块级内存态。
 */
beforeEach(() => {
  resetSafetyNotice();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('会话态', () => {
  it('首帧返回「显示」，标记后返回「不显示」', () => {
    expect(shouldShowSafetyNotice()).toBe(true);
    markSafetyNoticeShown();
    expect(shouldShowSafetyNotice()).toBe(false);
  });

  it('重复标记不报错，也不回到「显示」', () => {
    markSafetyNoticeShown();
    markSafetyNoticeShown();
    expect(shouldShowSafetyNotice()).toBe(false);
  });

  it('模块重载后重新返回「显示」（刷新即新会话）', async () => {
    markSafetyNoticeShown();
    vi.resetModules();
    const reloaded = await import('./safety-notice');
    expect(reloaded.shouldShowSafetyNotice()).toBe(true);
  });
});

describe('语义句与措辞（spec/06 §9.2）', () => {
  it('固定语义句含「基于照片的重建」与「无法替代真实」两段', () => {
    expect(SAFETY_NOTICE_TEXT).toContain('基于照片的重建');
    expect(SAFETY_NOTICE_TEXT).toContain('无法替代真实');
  });

  it('不指涉逝者 / 离开的人', () => {
    for (const banned of ['逝者', '离开的人']) expect(SAFETY_NOTICE_TEXT).not.toContain(banned);
  });
});

describe('不落任何存储（P00 §6）', () => {
  it('不触碰 localStorage / sessionStorage', () => {
    const setItem = vi.fn();
    const getItem = vi.fn();
    const removeItem = vi.fn();
    const storage = { setItem, getItem, removeItem } as unknown as Storage;
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);

    shouldShowSafetyNotice();
    markSafetyNoticeShown();
    shouldShowSafetyNotice();
    resetSafetyNotice();

    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});
