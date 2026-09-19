import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { anchorSchema, qualitySchema } from '../../../src/shared/types';
import { closeDb, getDb } from '../../../src/server/db/connection';
import { runMigrations } from '../../../src/server/db/migrate';
import { runSeed } from '../../../src/server/db/seed';
import { buildKey, getStorage, resetStorage } from '../../../src/server/storage';
import { insertPhoto } from '../../../src/server/db/repositories/photos';
import { nowIso } from '../../../src/server/domain/time';
import { SID_COOKIE, createSession } from '../../../src/server/auth/session';
import { readFixture } from '../../../src/server/ark/fixtures';
import { anchorExtractHandler } from '../../../src/jobs/handlers/anchorExtract';
import { POST } from './route';
import { DELETE as DELETE_ANCHOR, GET } from './[id]/route';
import { POST as RETRY } from './[id]/retry/route';
import { POST as CONFIRM } from './[id]/confirm/route';
import { revokeConsents } from '../../../src/server/domain/anchorService';
import { POST as UPLOAD } from '../photos/route';
import { POST as PREPROCESS } from '../photos/[id]/preprocess/route';

/**
 * 锚点端点层断言（`docs/prd/spec/03-接口契约.md` §3.3、`docs/prd/spec/07-验收标准.md` §2）：
 * `SEC-06`（`kind='generated'` → `400 INVALID_PARAM`）、张数与归属校验、`API-02`（响应形状走 shared schema）、
 * `retry` 新行语义，以及低质量样本回放后 `GET /api/anchors/:id` 的失败呈现。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-anchor-api-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  process.env.STORAGE_DIR = path.join(tmpDir, 'storage');
  closeDb();
  resetStorage();
  runMigrations();
  runSeed();
  getDb()
    .prepare(
      `INSERT INTO users (id, phone, nickname, status, daily_image_quota, created_at)
       VALUES (2, '13900000000', 'USER_B', 1, 20, '2026-01-01T00:00:00Z')`,
    )
    .run();
});

afterAll(() => {
  closeDb();
  resetStorage();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.STORAGE_DIR;
});

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
/**
 * 真实会话（`tickets/T12`）：所有请求统一带 `sid` cookie，等价于已登录的种子 DEV_USER。
 * 会话行在首次调用时懒建一次；`beforeAll` 已跑过 `migrate` + `seed`。
 */
let sid: string | null = null;
const asReq = (req: Request): NextRequest => {
  sid ??= createSession(1).token;
  req.headers.set('cookie', `${SID_COOKIE}=${sid}`);
  return req as unknown as NextRequest;
};
const body = <T>(req: Request, payload: T): NextRequest =>
  asReq(new Request('http://localhost/api/anchors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));

const jpeg = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 180 } } }).jpeg().toBuffer();

const upload = async (): Promise<{ id: number }> => {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(await jpeg(700, 500))], 'photo.jpg', { type: 'image/jpeg' }));
  const res = await UPLOAD(
    asReq(new Request('http://localhost/api/photos', { method: 'POST', body: form })),
    ctx({}),
  );
  return ((await res.json()) as { photo: { id: number } }).photo;
};

const preprocess = async (photoId: number): Promise<{ id: number }> => {
  const res = await PREPROCESS(
    asReq(new Request('http://localhost/x', { method: 'POST' })),
    ctx({ id: String(photoId) }),
  );
  return ((await res.json()) as { photo: { id: number } }).photo;
};

const createAnchor = (payload: unknown): Promise<Response> =>
  POST(body(new Request('http://localhost/api/anchors', { method: 'POST' }), payload), ctx({}));

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code;

const auditCount = (action: string): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?').get(action) as { n: number }).n;

const anchorCount = (): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM identity_anchors').get() as { n: number }).n;

const consentCount = (anchorId: number): number =>
  (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM consents WHERE anchor_id = ? AND revoked_at IS NULL')
      .get(anchorId) as { n: number }
  ).n;

const GOOD_FEATURES = readFixture<{ features: unknown }>('ark/anchor-extract.json').features;

/** 把锚点推进到 `succeeded`（confirm / retry 的前置），供用例跳过 worker。 */
const markSucceeded = (id: number): void => {
  getDb()
    .prepare(
      `UPDATE identity_anchors SET status = 'succeeded', anchor_text = @text, features_json = @features,
              finished_at = @at WHERE id = @id`,
    )
    .run({ id, text: '甲'.repeat(60), features: JSON.stringify(GOOD_FEATURES), at: nowIso() });
};

const jsonReq = (url: string, payload: unknown): NextRequest =>
  asReq(
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

const confirmAnchor = (id: number, payload: unknown): Promise<Response> =>
  CONFIRM(jsonReq(`http://localhost/api/anchors/${id}/confirm`, payload), ctx({ id: String(id) }));

const deleteAnchorReq = (id: number): Promise<Response> =>
  DELETE_ANCHOR(asReq(new Request(`http://localhost/api/anchors/${id}`, { method: 'DELETE' })), ctx({ id: String(id) }));

describe('POST /api/anchors', () => {
  it('202 + 通过 anchorSchema 的 queued 行；缺省 preprocessedPhotoId 时自动预处理；写一条 anchor.extract 审计', async () => {
    const photo = await upload();
    const before = auditCount('anchor.extract');

    const res = await createAnchor({ photoIds: [photo.id] });

    expect(res.status).toBe(202);
    const anchor = anchorSchema.parse(((await res.json()) as { anchor: unknown }).anchor);
    expect(anchor.status).toBe('queued');
    expect(anchor.attempt).toBe(0);
    expect(anchor.anchorText).toBeNull();
    expect(anchor.features).toBeNull();
    expect(anchor.promptVersion).toBe('anchor-v1');
    expect(anchor.sourcePhotos.map((p) => p.id)).toEqual([photo.id]);
    expect(anchor.preprocessedPhoto?.kind).toBe('preprocessed');
    expect(anchor.preprocessedPhoto?.id).toBeGreaterThan(photo.id);
    expect(auditCount('anchor.extract')).toBe(before + 1);
  });

  it('photoIds 为空 / 6 张以上 → 400 INVALID_PARAM', async () => {
    expect(await errorCode(await createAnchor({ photoIds: [] }))).toBe('INVALID_PARAM');
    const many = { photoIds: [1, 2, 3, 4, 5, 6] };
    expect((await createAnchor(many)).status).toBe(400);
    expect(await errorCode(await createAnchor(many))).toBe('INVALID_PARAM');
  });

  it('SEC-06：kind=generated 的照片 → 400 INVALID_PARAM（防链式自举）', async () => {
    const key = buildKey(1, 'png');
    const file = await getStorage().save(key, await jpeg(120, 120));
    const generated = insertPhoto({
      userId: 1,
      kind: 'generated',
      storageKey: key,
      mime: 'image/png',
      bytes: file.bytes,
      width: 120,
      height: 120,
      sha256: 'f'.repeat(64),
      sourcePhotoId: null,
      qualityJson: null,
      createdAt: nowIso(),
    });

    const res = await createAnchor({ photoIds: [generated.id] });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('INVALID_PARAM');
  });

  it('他人照片 / 不存在的照片 → 404 NOT_FOUND（不返回 403）', async () => {
    const photo = await upload();
    const row = getDb().prepare('UPDATE photos SET user_id = 2 WHERE id = ?').run(photo.id);
    expect(row.changes).toBe(1);
    expect((await createAnchor({ photoIds: [photo.id] })).status).toBe(404);
    expect(await errorCode(await createAnchor({ photoIds: [photo.id] }))).toBe('NOT_FOUND');
    expect((await createAnchor({ photoIds: [999999] })).status).toBe(404);
  });
});

describe('GET /api/anchors/:id', () => {
  it('200 + anchorSchema；不存在 → 404 ANCHOR_NOT_FOUND；未成功时两个产物字段为 null', async () => {
    const photo = await upload();
    const created = anchorSchema.parse(
      ((await (await createAnchor({ photoIds: [photo.id] })).json()) as { anchor: unknown }).anchor,
    );

    const res = await GET(asReq(new Request('http://localhost/x')), ctx({ id: String(created.id) }));
    expect(res.status).toBe(200);
    const anchor = anchorSchema.parse(((await res.json()) as { anchor: unknown }).anchor);
    expect(anchor.id).toBe(created.id);
    expect(anchor.anchorText).toBeNull();
    expect(anchor.features).toBeNull();
    expect(anchor.error).toBeNull();

    const missing = await GET(asReq(new Request('http://localhost/x')), ctx({ id: '999999' }));
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('ANCHOR_NOT_FOUND');
  });
});

describe('POST /api/anchors/:id/retry', () => {
  it('202 新行：attempt = 旧 + 1，继承 inputPhotoIds / preprocessedPhotoId，旧行不被覆盖', async () => {
    const photo = await upload();
    const created = anchorSchema.parse(
      ((await (await createAnchor({ photoIds: [photo.id] })).json()) as { anchor: unknown }).anchor,
    );
    markSucceeded(created.id);

    const res = await RETRY(asReq(new Request('http://localhost/x', { method: 'POST' })), ctx({ id: String(created.id) }));
    expect(res.status).toBe(202);
    const retried = anchorSchema.parse(((await res.json()) as { anchor: unknown }).anchor);
    expect(retried.id).not.toBe(created.id);
    expect(retried.attempt).toBe(1);
    expect(retried.status).toBe('queued');
    expect(retried.sourcePhotos.map((p) => p.id)).toEqual(created.sourcePhotos.map((p) => p.id));
    expect(retried.preprocessedPhoto?.id).toBe(created.preprocessedPhoto?.id);

    const old = anchorSchema.parse(
      ((await (await GET(asReq(new Request('http://localhost/x')), ctx({ id: String(created.id) }))).json()) as {
        anchor: unknown;
      }).anchor,
    );
    expect(old.attempt).toBe(0);
    expect(old.status).toBe('succeeded');
  });

  it('旧行未终态（queued）→ 409 ANCHOR_NOT_CONFIRMED，不产生新行（M04 §5.2 ②）', async () => {
    const photo = await upload();
    const created = anchorSchema.parse(
      ((await (await createAnchor({ photoIds: [photo.id] })).json()) as { anchor: unknown }).anchor,
    );
    const before = anchorCount();

    const res = await RETRY(asReq(new Request('http://localhost/x', { method: 'POST' })), ctx({ id: String(created.id) }));

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('ANCHOR_NOT_CONFIRMED');
    expect(anchorCount()).toBe(before);
  });

  it('不存在的锚点 → 404 ANCHOR_NOT_FOUND', async () => {
    const res = await RETRY(asReq(new Request('http://localhost/x', { method: 'POST' })), ctx({ id: '999999' }));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('ANCHOR_NOT_FOUND');
  });
});

describe('POST /api/anchors/:id/confirm', () => {
  const newAnchor = async (): Promise<{ id: number }> => {
    const photo = await upload();
    return anchorSchema.parse(
      ((await (await createAnchor({ photoIds: [photo.id] })).json()) as { anchor: unknown }).anchor,
    );
  };

  it('SEC-09：两项授权齐全 → 200，2 行有效 consents + 两条审计，且 agreed_at ≡ 审计 created_at', async () => {
    const created = await newAnchor();
    markSucceeded(created.id);
    const beforeConfirm = auditCount('anchor.confirm');
    const beforeAgree = auditCount('consent.agree');

    const res = await confirmAnchor(created.id, {
      confirmed: true,
      consents: ['photo_usage', 'family_agreement'],
    });

    expect(res.status).toBe(200);
    const out = (await res.json()) as { anchor: unknown; consents: string[] };
    const anchor = anchorSchema.parse(out.anchor);
    expect(anchor.confirmedByUser).toBe(true);
    expect(anchor.confirmedAt).not.toBeNull();
    expect(out.consents).toEqual(['photo_usage', 'family_agreement']);
    expect(consentCount(created.id)).toBe(2);
    expect(auditCount('anchor.confirm')).toBe(beforeConfirm + 1);
    expect(auditCount('consent.agree')).toBe(beforeAgree + 1);

    const agreed = getDb()
      .prepare('SELECT agreed_at FROM consents WHERE anchor_id = ? ORDER BY id LIMIT 1')
      .get(created.id) as { agreed_at: string };
    const auditRow = getDb()
      .prepare("SELECT created_at FROM audit_logs WHERE action = 'anchor.confirm' ORDER BY id DESC LIMIT 1")
      .get() as { created_at: string };
    expect(auditRow.created_at).toBe(agreed.agreed_at);
  });

  it('SEC-02：缺 family_agreement → 400 INVALID_PARAM（details.fields.consents），事务回滚、无任何写入', async () => {
    const created = await newAnchor();
    markSucceeded(created.id);
    const beforeConfirm = auditCount('anchor.confirm');

    const res = await confirmAnchor(created.id, { confirmed: true, consents: ['photo_usage'] });

    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string; details: { fields: { consents: string[] } } } };
    expect(err.error.code).toBe('INVALID_PARAM');
    expect(err.error.details.fields.consents).toEqual(['缺少 family_agreement']);
    const row = getDb()
      .prepare('SELECT confirmed_by_user FROM identity_anchors WHERE id = ?')
      .get(created.id) as { confirmed_by_user: number };
    expect(row.confirmed_by_user).toBe(0);
    expect(consentCount(created.id)).toBe(0);
    expect(auditCount('anchor.confirm')).toBe(beforeConfirm);
  });

  it('缺 photo_usage（反方向）也 → 400 且列出缺失项', async () => {
    const created = await newAnchor();
    markSucceeded(created.id);

    const res = await confirmAnchor(created.id, { confirmed: true, consents: ['family_agreement'] });

    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { details: { fields: { consents: string[] } } } };
    expect(err.error.details.fields.consents).toEqual(['缺少 photo_usage']);
    expect(consentCount(created.id)).toBe(0);
  });

  it('{ confirmed: false } → 400 INVALID_PARAM，不写行（schema z.literal(true)）', async () => {
    const created = await newAnchor();
    markSucceeded(created.id);

    const res = await confirmAnchor(created.id, { confirmed: false, consents: ['photo_usage', 'family_agreement'] });

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('INVALID_PARAM');
    expect(consentCount(created.id)).toBe(0);
  });

  it('锚点非 succeeded → 409 ANCHOR_NOT_CONFIRMED，不写行', async () => {
    const created = await newAnchor();

    const res = await confirmAnchor(created.id, {
      confirmed: true,
      consents: ['photo_usage', 'family_agreement'],
    });

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('ANCHOR_NOT_CONFIRMED');
    expect(consentCount(created.id)).toBe(0);
  });

  it('他人锚点 → 404 ANCHOR_NOT_FOUND（不返回 403）', async () => {
    const created = await newAnchor();
    markSucceeded(created.id);
    getDb().prepare('UPDATE identity_anchors SET user_id = 2 WHERE id = ?').run(created.id);

    const res = await confirmAnchor(created.id, {
      confirmed: true,
      consents: ['photo_usage', 'family_agreement'],
    });

    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('ANCHOR_NOT_FOUND');
  });

  it('重复 confirm → 仍 200，consents 仍 2 行、confirmed_at 不变，审计再写 2 条', async () => {
    const created = await newAnchor();
    markSucceeded(created.id);
    const payload = { confirmed: true, consents: ['photo_usage', 'family_agreement'] };

    const first = anchorSchema.parse(
      ((await (await confirmAnchor(created.id, payload)).json()) as { anchor: unknown }).anchor,
    );
    const beforeSecond = auditCount('anchor.confirm');
    const second = anchorSchema.parse(
      ((await (await confirmAnchor(created.id, payload)).json()) as { anchor: unknown }).anchor,
    );

    expect(second.confirmedAt).toBe(first.confirmedAt);
    expect(consentCount(created.id)).toBe(2);
    expect(auditCount('anchor.confirm')).toBe(beforeSecond + 1);
  });

  it('吊销 photo_usage 后再 confirm → 新增 1 行、旧行 revoked_at 仍非空（M04 §8.1 ④）', async () => {
    const created = await newAnchor();
    markSucceeded(created.id);
    const payload = { confirmed: true, consents: ['photo_usage', 'family_agreement'] };
    await confirmAnchor(created.id, payload);

    expect(revokeConsents(1, 'photo_usage')).toBeGreaterThan(0);
    await confirmAnchor(created.id, payload);

    const rows = getDb()
      .prepare('SELECT scope, revoked_at FROM consents WHERE anchor_id = ? ORDER BY id')
      .all(created.id) as Array<{ scope: string; revoked_at: string | null }>;
    expect(rows.filter((r) => r.scope === 'photo_usage')).toHaveLength(2);
    expect(rows.filter((r) => r.scope === 'photo_usage' && r.revoked_at !== null)).toHaveLength(1);
    expect(consentCount(created.id)).toBe(2);
  });
});

describe('DELETE /api/anchors/:id', () => {
  it('200 + cascaded 全零；锚点行物理删除（GET → 404）；写 anchor.delete 审计', async () => {
    const photo = await upload();
    const created = anchorSchema.parse(
      ((await (await createAnchor({ photoIds: [photo.id] })).json()) as { anchor: unknown }).anchor,
    );
    markSucceeded(created.id);
    const before = auditCount('anchor.delete');

    const res = await deleteAnchorReq(created.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cascaded: { generations: 0, results: 0 } });
    const after = await GET(asReq(new Request('http://localhost/x')), ctx({ id: String(created.id) }));
    expect(after.status).toBe(404);
    expect(auditCount('anchor.delete')).toBe(before + 1);
  });

  it('删除吊销该锚点的有效授权，但 consents 行保留（不删行）', async () => {
    const photo = await upload();
    const created = anchorSchema.parse(
      ((await (await createAnchor({ photoIds: [photo.id] })).json()) as { anchor: unknown }).anchor,
    );
    markSucceeded(created.id);
    await confirmAnchor(created.id, { confirmed: true, consents: ['photo_usage', 'family_agreement'] });

    await deleteAnchorReq(created.id);

    const rows = getDb()
      .prepare('SELECT revoked_at FROM consents WHERE anchor_id = ?')
      .all(created.id) as Array<{ revoked_at: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
  });

  it('已删除 / 不存在的锚点 → 200 幂等（cascaded 全零，M04 §5.4）', async () => {
    // 幂等：目标行已物理删除 → 200 全零（`modules/M04-身份确认与授权.md` §5.4、`spec/03-接口契约.md` §1.5）。
    const gone = await deleteAnchorReq(999999);
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ ok: true, cascaded: { generations: 0, results: 0 } });
  });

  it('他人锚点 → 404 ANCHOR_NOT_FOUND（不返回 403）', async () => {
    const photo = await upload();
    const created = anchorSchema.parse(
      ((await (await createAnchor({ photoIds: [photo.id] })).json()) as { anchor: unknown }).anchor,
    );
    getDb().prepare('UPDATE identity_anchors SET user_id = 2 WHERE id = ?').run(created.id);

    const res = await deleteAnchorReq(created.id);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('ANCHOR_NOT_FOUND');
  });
});

describe('低质量样本回放（M03 §6.1 / §8）', () => {
  it('回放 anchor-extract-fail.json 的 quality → GET 返回 failed + ANCHOR_LOW_QUALITY + quality', async () => {
    const failFixture = readFixture<{ quality: unknown }>('ark/anchor-extract-fail.json');
    const quality = qualitySchema.parse(failFixture.quality);
    const photo = await upload();
    const preprocessed = await preprocess(photo.id);
    getDb()
      .prepare('UPDATE photos SET quality_json = ? WHERE id = ?')
      .run(JSON.stringify(quality), preprocessed.id);

    const created = anchorSchema.parse(
      ((await (
        await createAnchor({ photoIds: [photo.id], preprocessedPhotoId: preprocessed.id })
      ).json()) as { anchor: unknown }).anchor,
    );

    await anchorExtractHandler({ anchorId: created.id });

    const res = await GET(asReq(new Request('http://localhost/x')), ctx({ id: String(created.id) }));
    const anchor = anchorSchema.parse(((await res.json()) as { anchor: unknown }).anchor);
    expect(anchor.status).toBe('failed');
    expect(anchor.error?.code).toBe('ANCHOR_LOW_QUALITY');
    expect(anchor.quality).toEqual(quality);
    expect(anchor.anchorText).toBeNull();
    expect(anchor.features).toBeNull();
    expect(anchor.finishedAt).not.toBeNull();
  });
});
