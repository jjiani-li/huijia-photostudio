import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { eraSceneConfigSchema } from '../../../src/shared/types';
import { closeDb } from '../../../src/server/db/connection';
import { runMigrations } from '../../../src/server/db/migrate';
import { runSeed } from '../../../src/server/db/seed';
import { SEED_VERSION } from '../../../src/server/prompt/versions';
import { SID_COOKIE, createSession } from '../../../src/server/auth/session';
import { GET } from './era-scene/route';

/**
 * `GET /api/config/era-scene` 的端点断言（`docs/prd/spec/03-接口契约.md` §3.4）：
 * `API-02`（响应走 `src/shared/types.ts` 的 zod schema）、`API-06`（不含 prompt 正文四字段）、
 * `DB-06`（`version` == 种子顶层 `version`）。HTTP 全链路的 B 层形态待 `tickets/T10` / `tickets/T13`
 * 的 HTTP 夹具接上后追加到 `scripts/acceptance.ts`。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-config-api-'));
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

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
/**
 * 真实会话（`tickets/T12`）：请求统一带 `sid` cookie，等价于已登录的种子 DEV_USER。
 * 会话行在首次调用时懒建一次；`beforeAll` 已跑过 `migrate` + `seed`。
 */
let sid: string | null = null;
const asReq = (req: Request): NextRequest => {
  sid ??= createSession(1).token;
  req.headers.set('cookie', `${SID_COOKIE}=${sid}`);
  return req as unknown as NextRequest;
};

const callGet = async (): Promise<{ status: number; body: unknown }> => {
  const res = await GET(asReq(new Request('http://localhost/api/config/era-scene')), ctx({}));
  return { status: res.status, body: await res.json() };
};

describe('API-02 · 响应形状', () => {
  it('200 且通过 shared 的 eraSceneConfigSchema', async () => {
    const { status, body } = await callGet();
    expect(status).toBe(200);
    const config = eraSceneConfigSchema.parse(body);
    expect(config.eras).toHaveLength(4);
    expect(config.scenes).toHaveLength(5);
    expect(config.profiles).toHaveLength(20);
    expect(config.eras.map((e) => e.code)).toEqual(['E1', 'E2', 'E3', 'E4']);
    expect(config.eras[0]?.isMono).toBe(true); // E1 黑白
  });
});

describe('API-06 · 不下发 prompt 正文与内部列', () => {
  it('响应与每个选项都不含 promptPack / spacePack / constraintPack / promptOverride', async () => {
    const { body } = await callGet();
    const serialized = JSON.stringify(body);
    for (const forbidden of ['promptPack', 'spacePack', 'constraintPack', 'promptOverride']) {
      expect(serialized.includes(forbidden), `响应泄漏了 ${forbidden}`).toBe(false);
    }
  });

  it('白名单键集合：顶层 / EraOption / SceneOption / EraSceneProfile', async () => {
    const { body } = await callGet();
    const config = eraSceneConfigSchema.parse(body);
    const raw = body as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(
      ['confidenceHintThreshold', 'eras', 'profiles', 'realismAnchor', 'scenes', 'version'].sort(),
    );
    expect(Object.keys(config.eras[0] as object).sort()).toEqual(
      ['caption', 'code', 'isMono', 'name', 'sampleUrl', 'slug', 'sortOrder'].sort(),
    );
    expect(Object.keys(config.scenes[0] as object).sort()).toEqual(
      ['caption', 'category', 'code', 'coverUrl', 'id', 'name', 'slug', 'sortOrder'].sort(),
    );
    expect(Object.keys(config.profiles[0] as object).sort()).toEqual(
      ['confidence', 'eraCode', 'sampleUrl', 'sceneId', 'visualSignature'].sort(),
    );
  });

  it('本期 sampleUrl / coverUrl 全为 null（无真实样片，前端降级为纯文字）', async () => {
    const { body } = await callGet();
    const config = eraSceneConfigSchema.parse(body);
    expect(config.eras.every((e) => e.sampleUrl === null)).toBe(true);
    expect(config.scenes.every((s) => s.coverUrl === null)).toBe(true);
    expect(config.profiles.every((p) => p.sampleUrl === null)).toBe(true);
  });
});

describe('DB-06 · version 与种子顶层一致', () => {
  it('响应 version == SEED_VERSION == era-scene-seed.json 顶层 version', async () => {
    const { body } = await callGet();
    const config = eraSceneConfigSchema.parse(body);
    const seed = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'docs/prd/spec/era-scene-seed.json'), 'utf8'),
    ) as { version: string; realismAnchor: string; confidenceHintThreshold: number };
    expect(config.version).toBe(SEED_VERSION);
    expect(config.version).toBe(seed.version);
    expect(config.realismAnchor).toBe(seed.realismAnchor);
    expect(config.confidenceHintThreshold).toBe(seed.confidenceHintThreshold);
  });
});
