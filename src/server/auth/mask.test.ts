import { describe, expect, it } from 'vitest';
import { maskEmail, maskIdentifier, maskPhone, toApiUser } from './mask';

/**
 * 脱敏（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1、§3.1）：输出必含 `*`，`null → null`。
 * `API-05` 断言 `GET /api/me` 的 `phone` / `email` 命中这些形状。
 */
describe('maskPhone', () => {
  it('保留前 3 与后 4 位，中间固定 4 个 *', () => {
    expect(maskPhone('13800138000')).toBe('138****8000');
  });

  it('长度不足 7 时整串替换为等长 *；null → null', () => {
    expect(maskPhone('123')).toBe('***');
    expect(maskPhone(null)).toBeNull();
  });
});

describe('maskEmail', () => {
  it('保留本地首字符 + *** + @ 域名原文', () => {
    expect(maskEmail('abcd@x.com')).toBe('a***@x.com');
  });

  it('local 长度 1 → ***@域；null → null', () => {
    expect(maskEmail('a@x.com')).toBe('***@x.com');
    expect(maskEmail(null)).toBeNull();
  });
});

describe('maskIdentifier / toApiUser', () => {
  it('含 @ 走邮箱，否则走手机号', () => {
    expect(maskIdentifier('abcd@x.com')).toBe('a***@x.com');
    expect(maskIdentifier('13800138000')).toBe('138****8000');
    expect(maskIdentifier(null)).toBeNull();
  });

  it('toApiUser 丢弃实名三列、脱敏 phone / email、保留 createdAt', () => {
    const user = toApiUser({
      id: 1,
      phone: '13800000000',
      email: null,
      nickname: 'DEV_USER',
      realName: '开发用户',
      idHash: 'dev-user-placeholder-hash',
      status: 1,
      dailyImageQuota: 20,
      createdAt: '2026-01-01T00:00:00Z',
      lastLoginAt: null,
      verifiedAt: '2026-01-01T00:00:00Z',
    });
    expect(user).toEqual({
      id: 1,
      phone: '138****0000',
      email: null,
      nickname: 'DEV_USER',
      status: 1,
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(Object.keys(user).sort()).toEqual(['createdAt', 'email', 'id', 'nickname', 'phone', 'status']);
  });
});
