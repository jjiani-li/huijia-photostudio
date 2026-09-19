import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { promptReverseJobSchema } from '../../../src/shared/types';
import { closeDb, getDb } from '../../../src/server/db/connection';
import { runMigrations } from '../../../src/server/db/migrate';
import { runSeed } from '../../../src/server/db/seed';
import { insertPhoto } from '../../../src/server/db/repositories/photos';
import { nowIso } from '../../../src/server/domain/time';
import { buildKey, getStorage, resetStorage } from '../../../src/server/storage';
import { SID_COOKIE, createSession } from '../../../src/server/auth/session';
import { resetArk } from '../../../src/server/ark';
import { reversePromptHandler } from '../../../src/jobs/handlers/reversePrompt';
import { POST } from './route';
import { GET } from './[id]/route';

/**
 * 反推端点层断言（`docs/prd/spec/03-接口契约.md` §3.8、§4）：`API-08` 的**不变量**——两个端点存在、
 * 请求 / 响应字段与契约一致且**不含未声明键**；归属 404、`kind='generated'` 400、鉴权 401；
 * 另走通一次「入队 → worker → 轮询」拿全五键产物。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-reverse-api-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  process.env.STORAGE_DIR = path.join(tmpDir, 'storage');
  process.env.PROVIDER = 'mock';
  closeDb();
  resetArk();
  resetStorage();
  runMigrations();
  runSeed();
  getDb()
    .prepare(
      `INSERT INTO users (id, phone, nickname, status, daily_image_quota, created_at)
       VALUES (2, '13900000011', 'USER_B', 1, 20, '2026-01-01T00:00:00Z')`,
    )
    .run();
});

afterAll(() => {
  closeDb();
  resetArk();
  resetStorage();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.STORAGE_DIR;
  delete process.env.PROVIDER;
});

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex');

/** 每个用户各自懒建一条真实会话（`tickets/T12`）；`tickets/T18` 的 404 用例需要第二个用户。 */
const sids = new Map<number, string>();
const asReq = (req: Request, userId = 1): NextRequest => {
  let token = sids.get(userId);
  if (token === undefined) {
    token = createSession(userId).token;
    sids.set(userId, token);
  }
  req.headers.set('cookie', `${SID_COOKIE}=${token}`);
  return req as unknown as NextRequest;
};

const post = (payload: unknown, userId = 1): NextRequest =>
  asReq(
    new Request('http://localhost/api/prompt-reverse-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    userId,
  );

const get = (id: string, userId = 1): NextRequest =>
  asReq(new Request(`http://localhost/api/prompt-reverse-jobs/${id}`), userId);

let seq = 0;
/** 一张「文件真实存在」的照片：handler 要读盘取 Base64，占位行会让它直接落 `INTERNAL`。 */
const insertPhotoOfKind = async (
  kind: 'original' | 'preprocessed' | 'generated',
  userId = 1,
): Promise<number> => {
  seq += 1;
  const buffer = await sharp({
    create: { width: 48 + seq, height: 32 + seq, channels: 3, background: { r: 180, g: 170, b: 160 } },
  })
    .jpeg()
    .toBuffer();
  const key = buildKey(userId, 'jpg');
  const saved = await getStorage().save(key, buffer);
  return insertPhoto({
    userId,
    kind,
    storageKey: key,
    mime: 'image/jpeg',
    bytes: saved.bytes,
    width: 48 + seq,
    height: 32 + seq,
    sha256: sha(`reverse-api-${seq}`),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  }).id;
};

/** `spec/03-接口契约.md` §4 的 `PromptReverseJob` 字段全集（多一个少一个都算漂移）。 */
const JOB_KEYS = [
  'createdAt',
  'error',
  'finishedAt',
  'id',
  'model',
  'photoId',
  'resultJson',
  'resultPrompt',
  'status',
  'suggestEraCode',
  'suggestSceneId',
];

const bodyOf = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

const codeOf = async (res: Response): Promise<string> =>
  ((await bodyOf(res)).error as { code?: string } | undefined)?.code ?? '';

describe('API-08 · 端点存在与字段形状', () => {
  it('未登录：两个端点都 401 UNAUTHENTICATED', async () => {
    const unauth = (url: string, init: RequestInit = {}): NextRequest =>
      new Request(url, init) as unknown as NextRequest;
    const created = await POST(
      unauth('http://localhost/api/prompt-reverse-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId: 1 }),
      }),
      ctx({}),
    );
    const read = await GET(unauth('http://localhost/api/prompt-reverse-jobs/1'), ctx({ id: '1' }));
    expect([created.status, read.status]).toEqual([401, 401]);
    expect([await codeOf(created), await codeOf(read)]).toEqual(['UNAUTHENTICATED', 'UNAUTHENTICATED']);
  });

  it('POST 入队：202 + `{ job }`，字段恰为契约声明的 11 个键', async () => {
    const res = await POST(post({ photoId: await insertPhotoOfKind('original') }), ctx({}));
    const body = await bodyOf(res);

    expect(res.status).toBe(202);
    expect(Object.keys(body)).toEqual(['job']);
    const job = body.job as Record<string, unknown>;
    expect(Object.keys(job).sort()).toEqual(JOB_KEYS);
    expect(promptReverseJobSchema.safeParse(job).success).toBe(true);
    expect(job.status).toBe('queued');
    expect(job.resultJson).toBeNull();
    expect(job.error).toBeNull();
  });

  it('请求体不是声明形状 → 400 INVALID_PARAM（缺 `photoId` / 多带未声明键的值 / 非正整数）', async () => {
    for (const payload of [{}, { photoId: 0 }, { photoId: '1' }, { photoId: 1.5 }, { photo: 1 }]) {
      const res = await POST(post(payload), ctx({}));
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect(await codeOf(res)).toBe('INVALID_PARAM');
    }
  });

  it('GET 轮询：200 + 同样 11 个键；`:id` 不是正整数 → 400', async () => {
    const created = await bodyOf(await POST(post({ photoId: await insertPhotoOfKind('original') }), ctx({})));
    const id = (created.job as { id: number }).id;

    const res = await GET(get(String(id)), ctx({ id: String(id) }));
    expect(res.status).toBe(200);
    const job = (await bodyOf(res)).job as Record<string, unknown>;
    expect(Object.keys(job).sort()).toEqual(JOB_KEYS);

    const bad = await GET(get('abc'), ctx({ id: 'abc' }));
    expect(bad.status).toBe(400);
    expect(await codeOf(bad)).toBe('INVALID_PARAM');
  });

  it('照片不存在 → 404 NOT_FOUND；`kind=\'generated\'` → 400 INVALID_PARAM', async () => {
    const missing = await POST(post({ photoId: 999_999 }), ctx({}));
    expect(missing.status).toBe(404);
    expect(await codeOf(missing)).toBe('NOT_FOUND');

    const generated = await POST(post({ photoId: await insertPhotoOfKind('generated') }), ctx({}));
    expect(generated.status).toBe(400);
    expect(await codeOf(generated)).toBe('INVALID_PARAM');
  });

  it('他人的任务 → 404 NOT_FOUND', async () => {
    const mine = await bodyOf(await POST(post({ photoId: await insertPhotoOfKind('original') }), ctx({})));
    const id = String((mine.job as { id: number }).id);
    const res = await GET(get(id, 2), ctx({ id }));
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe('NOT_FOUND');
  });
});

describe('入队 → worker → 轮询（REV-01 的产物形状）', () => {
  it('走通一次：五键 + resultPrompt + 推荐值齐全，且不含被忽略的 reasoning_content', async () => {
    const jobId = ((
      (await bodyOf(await POST(post({ photoId: await insertPhotoOfKind('preprocessed') }), ctx({})))).job as {
        id: number;
      }
    ).id);
    await reversePromptHandler({ jobId });

    const job = (await bodyOf(await GET(get(String(jobId)), ctx({ id: String(jobId) })))).job as {
      status: string;
      resultJson: Record<string, unknown> | null;
      resultPrompt: string | null;
      suggestEraCode: string | null;
      suggestSceneId: number | null;
    };

    expect(job.status).toBe('succeeded');
    expect(Object.keys(job.resultJson ?? {}).sort()).toEqual([
      'composition',
      'era',
      'lighting',
      'scene',
      'wardrobe',
    ]);
    expect(job.resultPrompt).toBeTruthy();
    expect(job.suggestEraCode).toBe('E2');
    expect(job.suggestSceneId).toBe(3);
    // 回放样本的 `reasoning_content` 里的措辞不得出现在响应里（`modules/M09` §5.1）。
    expect(JSON.stringify(job)).not.toContain('推荐年代取 E2');
  });
});
