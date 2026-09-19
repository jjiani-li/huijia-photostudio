import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../domain/errors';
import { assertDevCodeAllowed, ConsoleSmsSender, exposeDevCode, getSmsSender, resetSmsSender } from './sms';

/**
 * 短信通道与 `devCode` 口径（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1、§6、`SEC-07`）：
 * `SMS_PROVIDER=real` 无真实通道 → `INTERNAL`；`devCode` 仅 `console` 时允许。
 */
afterEach(() => {
  delete process.env.SMS_PROVIDER;
  resetSmsSender();
});

describe('exposeDevCode / getSmsSender', () => {
  it('缺省（console）→ exposeDevCode 为真、返回 ConsoleSmsSender', () => {
    expect(exposeDevCode()).toBe(true);
    expect(getSmsSender()).toBeInstanceOf(ConsoleSmsSender);
  });

  it('real → exposeDevCode 为假、getSmsSender 抛 INTERNAL', () => {
    process.env.SMS_PROVIDER = 'real';
    expect(exposeDevCode()).toBe(false);
    try {
      getSmsSender();
      expect.unreachable('应当抛 INTERNAL');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INTERNAL');
    }
  });
});

describe('assertDevCodeAllowed', () => {
  it('console 下带 devCode → 通过；不带 devCode 也可通过', () => {
    expect(() => assertDevCodeAllowed({ devCode: '000000' })).not.toThrow();
    expect(() => assertDevCodeAllowed({})).not.toThrow();
  });

  it('非 console 下带 devCode → INTERNAL', () => {
    process.env.SMS_PROVIDER = 'real';
    try {
      assertDevCodeAllowed({ devCode: '000000' });
      expect.unreachable('应当抛 INTERNAL');
    } catch (err) {
      expect((err as AppError).code).toBe('INTERNAL');
    }
  });
});
