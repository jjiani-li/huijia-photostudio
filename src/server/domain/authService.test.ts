import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { insert as insertLoginCode } from '../db/repositories/loginCodes';
import * as users from '../db/repositories/users';
import { AppError } from './errors';
import { nicknameForId, loginWithCode, logout, requestLoginCode } from './authService';
import { SID_COOKIE, hashToken } from '../auth/session';
import { resetSmsSender } from '../auth/sms';

/**
 * 验证码账号与会话编排（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1、§8）：
 * 节流、登录三态、首登建号与 `nickname` 规则、`sessions.token_hash`、登出吊销与审计。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-auth-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  process.env.SMS_PROVIDER = 'console';
  closeDb();
  resetSmsSender();
  runMigrations();
  runSeed();
});

afterAll(() => {
  closeDb();
  resetSmsSender();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.SMS_PROVIDER;
});

beforeEach(() => {
  getDb().prepare('DELETE FROM sessions').run();
  getDb().prepare('DELETE FROM login_codes').run();
  getDb().prepare("DELETE FROM audit_logs WHERE action IN ('auth.code_sent', 'auth.login', 'auth.logout')").run();
  getDb().prepare('DELETE FROM users WHERE id <> 1').run();
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'NO_THROW';
  } catch (err) {
    return err instanceof AppError ? err.code : `NON_APP_ERROR:${String(err)}`;
  }
};

const userCount = (): number => (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

describe('requestLoginCode（发码与节流，API-07）', () => {
  it('首次发码：sent + expiresInSec=600 + devCode（console）；写 login_codes 与 auth.code_sent 审计', () => {
    const result = requestLoginCode({ identifier: '13900000001' });
    expect(result.sent).toBe(true);
    expect(result.expiresInSec).toBe(600);
    expect(result.devCode).toMatch(/^\d{6}$/);

    const row = getDb()
      .prepare("SELECT identifier, purpose, consumed_at FROM login_codes WHERE identifier = '13900000001'")
      .get() as { identifier: string; purpose: string; consumed_at: string | null };
    expect(row.identifier).toBe('13900000001');
    expect(row.purpose).toBe('login');
    expect(row.consumed_at).toBeNull();
    const audits = getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.code_sent'")
      .get() as { n: number };
    expect(audits.n).toBe(1);
  });

  it('同 identifier 60 秒内二次发码 → CODE_RATE_LIMITED', () => {
    requestLoginCode({ identifier: '13900000002' });
    expect(codeOf(() => requestLoginCode({ identifier: '13900000002' }))).toBe('CODE_RATE_LIMITED');
  });

  it('归一化后才查节流：手机号的三种写法视为同一 identifier', () => {
    requestLoginCode({ identifier: '13900000003' });
    expect(codeOf(() => requestLoginCode({ identifier: '+86 139 0000 0003' }))).toBe('CODE_RATE_LIMITED');
  });
});

describe('loginWithCode（三态校验顺序：存在/已消费 → 过期 → 码值）', () => {
  it('无记录 → CODE_INVALID', () => {
    expect(codeOf(() => loginWithCode({ identifier: '13900000011', code: '000000' }))).toBe('CODE_INVALID');
  });

  it('记录已消费 → CODE_INVALID', () => {
    const { devCode } = requestLoginCode({ identifier: '13900000012' });
    loginWithCode({ identifier: '13900000012', code: devCode ?? '' });
    expect(codeOf(() => loginWithCode({ identifier: '13900000012', code: devCode ?? '' }))).toBe('CODE_INVALID');
  });

  it('记录存在且未消费但已过期 → CODE_EXPIRED', () => {
    insertLoginCode({
      identifier: '13900000013',
      code: '123456',
      purpose: 'login',
      expiresAt: '2000-01-01T00:00:00.000Z',
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    expect(codeOf(() => loginWithCode({ identifier: '13900000013', code: '123456' }))).toBe('CODE_EXPIRED');
  });

  it('码值不符 / 长度非 6 → CODE_INVALID', () => {
    const { devCode } = requestLoginCode({ identifier: '13900000014' });
    const wrong = devCode === '111111' ? '222222' : '111111';
    expect(codeOf(() => loginWithCode({ identifier: '13900000014', code: wrong }))).toBe('CODE_INVALID');
    expect(codeOf(() => loginWithCode({ identifier: '13900000014', code: '12' }))).toBe('CODE_INVALID');
  });

  it('console 下 DEV_LOGIN_CODE 是万能码（仍需未消费未过期）', () => {
    requestLoginCode({ identifier: '13900000015' });
    const { user } = loginWithCode({ identifier: '13900000015', code: '000000' });
    expect(user.phone).toBe('13900000015');
  });
});

describe('首登建号、会话与审计', () => {
  it('首次登录建号：nickname 按规则、写 last_login_at、token_hash = sha256(token)、写 auth.login', () => {
    const { devCode } = requestLoginCode({ identifier: '13900000021' });
    const { user, token } = loginWithCode({ identifier: '13900000021', code: devCode ?? '' });

    expect(user.nickname).toBe(nicknameForId(user.id));
    expect(user.nickname).toMatch(/^用户\d{4}$/);
    const row = users.findById(user.id);
    expect(row?.lastLoginAt).not.toBeNull();

    const session = getDb().prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(user.id) as {
      token_hash: string;
    };
    expect(session.token_hash).toBe(hashToken(token));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const audits = getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.login' AND user_id = ?")
      .get(user.id) as { n: number };
    expect(audits.n).toBe(1);
  });

  it('已存在用户（DEV_USER 手机号）再登录不建新号', () => {
    const before = userCount();
    const { devCode } = requestLoginCode({ identifier: '13800000000' });
    const { user } = loginWithCode({ identifier: '13800000000', code: devCode ?? '' });
    expect(user.id).toBe(1);
    expect(userCount()).toBe(before);
  });

  it('logout 吊销会话并写 auth.logout；重复 logout 幂等', () => {
    const { devCode } = requestLoginCode({ identifier: '13900000022' });
    const { user, token } = loginWithCode({ identifier: '13900000022', code: devCode ?? '' });
    const req = new Request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${SID_COOKIE}=${token}` },
    });

    logout(req);
    const row = getDb().prepare('SELECT revoked_at FROM sessions WHERE user_id = ?').get(user.id) as {
      revoked_at: string | null;
    };
    expect(row.revoked_at).not.toBeNull();
    const audits = getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.logout' AND user_id = ?")
      .get(user.id) as { n: number };
    expect(audits.n).toBe(1);

    logout(req);
    expect(
      (getDb().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.logout'").get() as { n: number }).n,
    ).toBe(1);
  });
});
