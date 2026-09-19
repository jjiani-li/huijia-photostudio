import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { SID_COOKIE, createSession, destroySession, getSessionUser, requireUser } from './session';
import { AppError } from '../domain/errors';
import { insert as insertSession } from '../db/repositories/sessions';

/**
 * 真实会话的读取规则（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1）：
 * cookie 缺失 / 格式非法**不查库**直接 `null`；命中 `sessions` 活跃行（未吊销且未过期）再查 `users.status=1`。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-session-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  closeDb();
  runMigrations();
  runSeed();
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

beforeEach(() => {
  getDb().prepare('DELETE FROM sessions').run();
  getDb().prepare('UPDATE users SET status = 1 WHERE id = 1').run();
});

const reqWith = (token: string): Request =>
  new Request('http://localhost/api/me', { headers: { cookie: `${SID_COOKIE}=${token}` } });

describe('getSessionUser', () => {
  it('无请求 / 无 cookie → null', () => {
    expect(getSessionUser()).toBeNull();
    expect(getSessionUser(new Request('http://localhost/api/me'))).toBeNull();
  });

  it('cookie 存在但格式非法（非 43 位 base64url）→ null', () => {
    expect(getSessionUser(reqWith('short'))).toBeNull();
    expect(getSessionUser(reqWith('!'.repeat(43)))).toBeNull();
  });

  it('格式合法但无对应会话行 → null', () => {
    expect(getSessionUser(reqWith('a'.repeat(43)))).toBeNull();
  });

  it('有效会话 → 返回 SessionUser（不含 createdAt / 实名三列）', () => {
    const { token } = createSession(1);
    const user = getSessionUser(reqWith(token));
    expect(user).toEqual({ id: 1, phone: '13800000000', email: null, nickname: 'DEV_USER', status: 1 });
  });

  it('已吊销 / 已过期 → null', () => {
    const { token } = createSession(1);
    destroySession(token);
    expect(getSessionUser(reqWith(token))).toBeNull();

    insertSession({
      userId: 1,
      tokenHash: 'f'.repeat(64),
      expiresAt: '2000-01-01T00:00:00.000Z',
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    expect(getSessionUser(reqWith('f'.repeat(43)))).toBeNull();
  });

  it('users.status = 0 → null', () => {
    const { token } = createSession(1);
    getDb().prepare('UPDATE users SET status = 0 WHERE id = 1').run();
    expect(getSessionUser(reqWith(token))).toBeNull();
  });
});

describe('requireUser', () => {
  it('未登录 → UNAUTHENTICATED', () => {
    try {
      requireUser(new Request('http://localhost/api/me'));
      expect.unreachable('应当抛 UNAUTHENTICATED');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('UNAUTHENTICATED');
    }
  });

  it('已登录 → 返回 SessionUser', () => {
    const { token } = createSession(1);
    expect(requireUser(reqWith(token)).id).toBe(1);
  });
});
