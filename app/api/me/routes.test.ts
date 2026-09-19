import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { quotaSchema, userSchema } from '../../../src/shared/types';
import { closeDb } from '../../../src/server/db/connection';
import { runMigrations } from '../../../src/server/db/migrate';
import { runSeed } from '../../../src/server/db/seed';
import { SID_COOKIE, createSession } from '../../../src/server/auth/session';
import { GET } from './route';

/**
 * `GET /api/me` 的端点断言（`docs/prd/spec/03-接口契约.md` §3.1、§4）：
 * `API-03`（未登录 → 401 `UNAUTHENTICATED`）、`API-05`（`user.phone` / `email` 经 `mask.ts`、无明文）、
 * `API-02`（响应形状走 `src/shared/types.ts` 的 zod schema）。
 */
let tmpDir: string;
let sid = '';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-me-api-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  closeDb();
  runMigrations();
  runSeed();
  sid = createSession(1).token;
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

const ctx = { params: Promise.resolve({}) };
const authedReq = (): NextRequest =>
  new Request('http://localhost/api/me', { headers: { cookie: `${SID_COOKIE}=${sid}` } }) as unknown as NextRequest;

describe('API-02 / API-05 · 响应形状与脱敏', () => {
  it('200：user 通过 userSchema、quota 通过 quotaSchema；phone 脱敏、无明文', async () => {
    const res = await GET(authedReq(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown; quota: unknown };
    const user = userSchema.parse(body.user);
    const quota = quotaSchema.parse(body.quota);

    expect(user.phone).toBe('138****0000');
    expect(user.email).toBeNull();
    expect(quota.limit).toBe(20);
    expect(JSON.stringify(body)).not.toContain('13800000000');
    // 实名三列与 daily_image_quota 不得下发
    expect(Object.keys(user).sort()).toEqual(['createdAt', 'email', 'id', 'nickname', 'phone', 'status']);
    expect(Object.keys(quota).sort()).toEqual(['day', 'images', 'limit', 'remaining']);
  });
});

describe('API-03 · 未登录', () => {
  it('无 cookie → 401 UNAUTHENTICATED', async () => {
    const res = await GET(new Request('http://localhost/api/me') as unknown as NextRequest, ctx);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });
});
