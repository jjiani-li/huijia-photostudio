import { describe, expect, it } from 'vitest';
import { AppError } from '../domain/errors';
import { normalizeIdentifier } from './identifier';

/**
 * `normalizeIdentifier`（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1、§8）：
 * 归一化结果即 `login_codes.identifier` 与 `users.phone` / `users.email` 的唯一写入值。
 */
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'NO_THROW';
  } catch (err) {
    return err instanceof AppError ? err.code : `NON_APP_ERROR:${String(err)}`;
  }
};

describe('手机号', () => {
  it('去掉空格 / 连字符 / 括号，剥离 +86 与前导 86，恒为 11 位纯数字', () => {
    expect(normalizeIdentifier('13800138000')).toBe('13800138000');
    expect(normalizeIdentifier(' 138 0013 8000 ')).toBe('13800138000');
    expect(normalizeIdentifier('(138) 0013-8000')).toBe('13800138000');
    expect(normalizeIdentifier('+86 138-0013-8000')).toBe('13800138000');
    expect(normalizeIdentifier('8613800138000')).toBe('13800138000');
  });

  it('非法（不足 11 位 / 非 1[3-9] 开头）→ INVALID_PARAM', () => {
    expect(codeOf(() => normalizeIdentifier('12345'))).toBe('INVALID_PARAM');
    expect(codeOf(() => normalizeIdentifier('12800138000'))).toBe('INVALID_PARAM');
    expect(codeOf(() => normalizeIdentifier(''))).toBe('INVALID_PARAM');
  });
});

describe('邮箱', () => {
  it('转小写；含 @ 自动识别，显式 channel=email 亦走邮箱', () => {
    expect(normalizeIdentifier('AbCd@X.com')).toBe('abcd@x.com');
    expect(normalizeIdentifier('  A@B.cn  ', 'email')).toBe('a@b.cn');
  });

  it('格式非法 → INVALID_PARAM', () => {
    expect(codeOf(() => normalizeIdentifier('a@b'))).toBe('INVALID_PARAM');
    expect(codeOf(() => normalizeIdentifier('not-an-email', 'email'))).toBe('INVALID_PARAM');
  });
});
