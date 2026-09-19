import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { realNameStatusSchema } from '../../../../src/shared/types';
import { closeDb, getDb } from '../../../../src/server/db/connection';
import { runMigrations } from '../../../../src/server/db/migrate';
import { runSeed } from '../../../../src/server/db/seed';
import { insertUser } from '../../../../src/server/db/repositories/users';
import { idHashOf } from '../../../../src/server/auth/idVerify';
import { SID_COOKIE, createSession } from '../../../../src/server/auth/session';
import { nowIso } from '../../../../src/server/domain/time';
import { GET, POST } from './route';

/**
 * `GET` / `POST /api/me/realname` 的端点断言（`docs/prd/spec/03-接口契约.md` §3.1、§4、
 * `docs/prd/spec/07-验收标准.md` §2.10 的 `API-09`）：请求 / 响应字段形状、未登录 401、
 * `details.fields`，以及证件号明文与三个列名都不出现在响应里。
 */
let tmpDir: string;
/** 一个未实名的新用户（`verified_at IS NULL`）。 */
let freshUserId = 0;
let freshSid = '';
/** 另一个已实名用户：`id_hash` 已被 `VALID_ID` 占用。 */
let takenSid = '';
let devSid = '';

const VALID_ID = '11010519491231002X';
const OTHER_VALID_ID = '310101199001011234';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-realname-api-'));
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
  getDb().prepare('DELETE FROM users WHERE id <> 1').run();
  getDb().prepare("DELETE FROM audit_logs WHERE action = 'auth.realname'").run();
  getDb().prepare('DELETE FROM sessions').run();

  const fresh = insertUser({ phone: '13900001111', email: null, nickname: '待实名', createdAt: nowIso() });
  freshUserId = fresh.id;
  freshSid = createSession(fresh.id).token;

  // 已实名用户：`id_hash` 已被 `VALID_ID` 占用（唯一性冲突的对手，也是「同一个人重提」的样本）。
  const taken = getDb()
    .prepare(
      `INSERT INTO users (phone, nickname, real_name, id_hash, verified_at, status, daily_image_quota, created_at)
       VALUES ('13900002222', '已实名', '李四', ?, ?, 1, 20, ?)`,
    )
    .run(idHashOf(VALID_ID), nowIso(), nowIso());
  takenSid = createSession(Number(taken.lastInsertRowid)).token;
  devSid = createSession(1).token;
});

const req = (sid: string, init: RequestInit = {}): NextRequest =>
  new Request('http://localhost/api/me/realname', {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: `${SID_COOKIE}=${sid}` },
  }) as unknown as NextRequest;

const ctx = { params: Promise.resolve({}) };

const post = (sid: string, payload: unknown): Promise<Response> =>
  POST(
    req(sid, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    ctx,
  );

const userRow = (id: number): { real_name: string | null; id_hash: string | null; verified_at: string | null } =>
  getDb().prepare('SELECT real_name, id_hash, verified_at FROM users WHERE id = ?').get(id) as {
    real_name: string | null;
    id_hash: string | null;
    verified_at: string | null;
  };

const realnameAudits = (): number =>
  (getDb().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.realname'").get() as { n: number }).n;

describe('API-09 · 响应形状（spec/03 §3.1、§4）', () => {
  it('GET 未实名：verified=false / verifiedAt=null / realName=null，键只有 realNameStatus', async () => {
    const res = await GET(req(freshSid), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { realNameStatus: unknown };
    expect(Object.keys(body)).toEqual(['realNameStatus']);
    expect(realNameStatusSchema.parse(body.realNameStatus)).toEqual({
      verified: false,
      verifiedAt: null,
      realName: null,
    });
  });

  it('GET 已实名（DEV_USER）：verified=true + realName + verifiedAt', async () => {
    const res = await GET(req(devSid), ctx);
    const status = realNameStatusSchema.parse(((await res.json()) as { realNameStatus: unknown }).realNameStatus);
    expect(status.verified).toBe(true);
    expect(status.realName).toBe('开发用户');
    expect(status.verifiedAt).not.toBeNull();
  });

  it('POST 成功：200 + realNameStatus，且响应体不含证件号明文与三个列名', async () => {
    const res = await post(freshSid, { realName: '张三', idNumber: OTHER_VALID_ID });
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    const status = realNameStatusSchema.parse((JSON.parse(raw) as { realNameStatus: unknown }).realNameStatus);
    expect(status.verified).toBe(true);
    expect(status.realName).toBe('张三');
    for (const leak of [OTHER_VALID_ID, 'id_hash', 'real_name', 'verified_at', 'daily_image_quota']) {
      expect(raw).not.toContain(leak);
    }
  });

  it('未登录：GET / POST 都是 401 UNAUTHENTICATED', async () => {
    const bare = new Request('http://localhost/api/me/realname') as unknown as NextRequest;
    for (const res of [await GET(bare, ctx), await POST(bare, ctx)]) {
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
    }
  });
});

describe('POST · 校验与落库（RN-02 / RN-04）', () => {
  it('格式非法 → 400 INVALID_PARAM + details.fields，且不写库、不写审计', async () => {
    const before = userRow(freshUserId);
    const res = await post(freshSid, { realName: '张3', idNumber: '123' });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string; details: { fields: Record<string, string[]> } } };
    expect(err.error.code).toBe('INVALID_PARAM');
    expect(Object.keys(err.error.details.fields).sort()).toEqual(['idNumber', 'realName']);
    expect(userRow(freshUserId)).toEqual(before);
    expect(realnameAudits()).toBe(0);
  });

  it('请求体不是合法 JSON → 400 INVALID_PARAM', async () => {
    const res = await POST(
      req(freshSid, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_PARAM');
  });

  it('唯一性冲突：证件号已被其他用户占用 → 400 INVALID_PARAM（fields.idNumber），不写库不写审计', async () => {
    const before = userRow(freshUserId);
    const res = await post(freshSid, { realName: '张三', idNumber: VALID_ID });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string; details: { fields: Record<string, string[]> } } };
    expect(err.error.code).toBe('INVALID_PARAM');
    expect(Object.keys(err.error.details.fields)).toEqual(['idNumber']);
    expect(userRow(freshUserId)).toEqual(before);
    expect(realnameAudits()).toBe(0);
  });

  it('同一用户重复提交同一证件号 → 200 且幂等（哈希 / 实名时间不变、不重复写审计）', async () => {
    const first = await post(freshSid, { realName: '张三', idNumber: OTHER_VALID_ID });
    expect(first.status).toBe(200);
    const row = userRow(freshUserId);

    // 换个大小写写法重提：归一化后是同一证件号 → 同一个哈希，不是新的一次实名。
    const again = await post(freshSid, { realName: '张三', idNumber: OTHER_VALID_ID.toLowerCase() });
    expect(again.status).toBe(200);
    expect(userRow(freshUserId)).toEqual(row);
    expect(realnameAudits()).toBe(1);
  });

  it('同一用户重提时以库里已登记的姓名为准（不改写）', async () => {
    const res = await post(takenSid, { realName: '王五', idNumber: VALID_ID });
    expect(res.status).toBe(200);
    const status = realNameStatusSchema.parse(((await res.json()) as { realNameStatus: unknown }).realNameStatus);
    expect(status.realName).toBe('李四');
    expect(realnameAudits()).toBe(0);
  });

  it('成功：三列写齐 + id_hash = sha256（非明文）+ 一条 auth.realname 审计（target=user:{id}）', async () => {
    const res = await post(freshSid, { realName: ' 张三 ', idNumber: OTHER_VALID_ID.toLowerCase() });
    expect(res.status).toBe(200);
    const row = userRow(freshUserId);
    expect(row.real_name).toBe('张三');
    expect(row.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.id_hash).not.toBe(OTHER_VALID_ID);
    expect(row.id_hash).toBe(idHashOf(OTHER_VALID_ID));
    expect(row.verified_at).not.toBeNull();

    const audit = getDb()
      .prepare("SELECT user_id, target, created_at FROM audit_logs WHERE action = 'auth.realname'")
      .get() as { user_id: number; target: string; created_at: string };
    expect(audit.user_id).toBe(freshUserId);
    expect(audit.target).toBe(`user:${freshUserId}`);
    // 同一事务、同一时刻：`users.verified_at` 与审计行的 `created_at` 逐字符相等（RN-04 的同事务口径）。
    expect(audit.created_at).toBe(row.verified_at);
  });
});
