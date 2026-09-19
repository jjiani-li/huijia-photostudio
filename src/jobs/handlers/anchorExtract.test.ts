import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../server/db/connection';
import { runMigrations } from '../../server/db/migrate';
import { runSeed } from '../../server/db/seed';
import { buildKey, getStorage, resetStorage } from '../../server/storage';
import { insertPhoto } from '../../server/db/repositories/photos';
import { findById, insert, type InsertAnchorInput } from '../../server/db/repositories/anchors';
import { nowIso } from '../../server/domain/time';
import { ANCHOR_V1_SYSTEM_PROMPT } from '../../server/prompt/versions';
import { ArkUpstreamError } from '../../server/ark/errors';
import { readFixture } from '../../server/ark/fixtures';
import { RealArkProvider } from '../../server/ark/real';
import type { AnchorExtractInput, AnchorExtractResult } from '../../server/ark/types';
import type { AnchorFeatures, Quality } from '../../shared/types';
import {
  ANCHOR_MAX_LENGTH,
  ANCHOR_MIN_LENGTH,
  anchorExtractHandler,
  parseAnchorResponse,
  stripFence,
} from './anchorExtract';

/**
 * `anchorExtractHandler` 的单元测试（`docs/prd/modules/M03-身份锚点提取.md` §8 的全部用例）。
 * `getArk()` 用桩替换：本文件断言的是 handler 的状态机、质量前置与容错解析，不是 fixture 回放本身。
 */
const { arkStub } = vi.hoisted(() => ({
  arkStub: { extractAnchor: vi.fn(), generateImage: vi.fn() },
}));

vi.mock('../../server/ark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/ark')>();
  return { ...actual, getArk: () => arkStub };
});

interface AnchorFixture {
  model: string;
  anchorText: string;
  features: AnchorFeatures;
  quality: Quality;
}

const fixture = readFixture<AnchorFixture>('ark/anchor-extract.json');
const failFixture = readFixture<AnchorFixture>('ark/anchor-extract-fail.json');

const GOOD: Quality = {
  usable: true,
  faceDetected: true,
  faceCount: 1,
  sharpness: 0.6,
  readability: 0.7,
  damageLevel: 0.3,
  warnings: [],
  advice: null,
};

const result = (over: Partial<{ anchorText: string; features: AnchorFeatures }> = {}): AnchorExtractResult => ({
  raw: JSON.stringify({ anchor: over.anchorText ?? fixture.anchorText, features: over.features ?? fixture.features }),
  model: fixture.model,
});

let tmpDir: string;
let seq = 0;
const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex');
const textOf = (n: number): string => '甲'.repeat(n);

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-anchor-handler-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  process.env.STORAGE_DIR = path.join(tmpDir, 'storage');
  closeDb();
  resetStorage();
  runMigrations();
  runSeed();
});

afterAll(() => {
  closeDb();
  resetStorage();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.STORAGE_DIR;
});

beforeEach(() => {
  arkStub.extractAnchor.mockReset();
  arkStub.generateImage.mockReset();
});

const saveJpeg = async (width: number, height: number): Promise<{ key: string; bytes: number }> => {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 110, b: 100 } },
  })
    .jpeg()
    .toBuffer();
  const key = buildKey(1, 'jpg');
  const saved = await getStorage().save(key, buffer);
  return { key, bytes: saved.bytes };
};

/** 一张原图 + 一张派生预处理图（预处理图的 `quality_json` 由用例指定）。 */
const seedPair = async (quality: Quality | null) => {
  seq += 1;
  const originalFile = await saveJpeg(600 + seq, 400 + seq);
  const original = insertPhoto({
    userId: 1,
    kind: 'original',
    storageKey: originalFile.key,
    mime: 'image/jpeg',
    bytes: originalFile.bytes,
    width: 600 + seq,
    height: 400 + seq,
    sha256: sha(`original-${seq}`),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  });
  const preFile = await saveJpeg(1500 + seq, 1000 + seq);
  const pre = insertPhoto({
    userId: 1,
    kind: 'preprocessed',
    storageKey: preFile.key,
    mime: 'image/jpeg',
    bytes: preFile.bytes,
    width: 1500 + seq,
    height: 1000 + seq,
    sha256: sha(`preprocessed-${seq}`),
    sourcePhotoId: original.id,
    qualityJson: quality,
    createdAt: nowIso(),
  });
  return { original, pre };
};

const queuedAnchor = (
  inputPhotoIds: number[],
  preprocessedPhotoId: number | null,
  over: Partial<InsertAnchorInput> = {},
): number =>
  insert({
    userId: 1,
    inputPhotoIds,
    preprocessedPhotoId,
    status: 'queued',
    attempt: 0,
    model: fixture.model,
    promptVersion: 'anchor-v1',
    quality: null,
    createdAt: nowIso(),
    ...over,
  }).id;

const storedFeatures = (anchorId: number): Record<string, unknown> => {
  const row = getDb()
    .prepare('SELECT features_json FROM identity_anchors WHERE id = ?')
    .get(anchorId) as { features_json: string | null };
  return JSON.parse(row.features_json ?? '{}') as Record<string, unknown>;
};

const run = (anchorId: number): Promise<void> => anchorExtractHandler({ anchorId });

describe('§5.5 · 容错解析六步', () => {
  it('第 1 步：剥 ```json 包裹后解析成功', () => {
    const inner = JSON.stringify({ anchor: fixture.anchorText, features: fixture.features });
    const raw = `\`\`\`json\n${inner}\n\`\`\``;
    expect(stripFence(raw)).toBe(inner);
    expect(parseAnchorResponse(raw)).toMatchObject({ ok: true, anchorText: fixture.anchorText });
  });

  it('第 2 步：空串 / 非法 JSON / 非对象 → 失败，不产出 anchorText', () => {
    for (const raw of ['', '   ', 'not-json', '[1,2]', '"text"', 'null']) {
      expect(parseAnchorResponse(raw)).toMatchObject({ ok: false });
    }
  });

  it('第 3 步：`features` 缺键或类型不符 → 失败；多一个键 → 成功且恰 12 键', () => {
    const { ageRange, ...missing } = fixture.features;
    void ageRange;
    expect(
      parseAnchorResponse(JSON.stringify({ anchor: fixture.anchorText, features: missing })),
    ).toMatchObject({ ok: false });
    expect(
      parseAnchorResponse(
        JSON.stringify({ anchor: fixture.anchorText, features: { ...fixture.features, eyes: 3 } }),
      ),
    ).toMatchObject({ ok: false });

    const parsed = parseAnchorResponse(
      JSON.stringify({ anchor: fixture.anchorText, features: { ...fixture.features, extra: '多余键' } }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys(parsed.features)).toHaveLength(12);
      expect(parsed.features).not.toHaveProperty('extra');
    }
  });

  it('第 4 步：长度窗口是 60–120 字符（60 / 120 通过，59 / 121 失败）', () => {
    for (const n of [ANCHOR_MIN_LENGTH, ANCHOR_MAX_LENGTH]) {
      expect(
        parseAnchorResponse(JSON.stringify({ anchor: textOf(n), features: fixture.features })).ok,
      ).toBe(true);
    }
    for (const n of [ANCHOR_MIN_LENGTH - 1, ANCHOR_MAX_LENGTH + 1]) {
      expect(
        parseAnchorResponse(JSON.stringify({ anchor: textOf(n), features: fixture.features })).ok,
      ).toBe(false);
    }
  });

  it('第 5 / 6 步：否定词与美化词命中 → 失败', () => {
    for (const anchor of [`不要修饰这张脸的描述${'，保持原样'.repeat(8)}`, `慈祥的老年男性${'，五官普通'.repeat(9)}`]) {
      expect(parseAnchorResponse(JSON.stringify({ anchor, features: fixture.features }))).toMatchObject({
        ok: false,
      });
    }
  });
});

describe('§5.3 · handler 状态机', () => {
  it('成功：写 succeeded + 全部产物字段，上游只调一次', async () => {
    const { original, pre } = await seedPair(GOOD);
    const anchorId = queuedAnchor([original.id], pre.id);
    arkStub.extractAnchor.mockResolvedValue(result());

    await run(anchorId);

    const row = findById(anchorId);
    expect(row?.status).toBe('succeeded');
    expect(row?.anchorText).toBe(fixture.anchorText);
    expect(Object.keys(storedFeatures(anchorId))).toHaveLength(12);
    expect(row?.quality?.readability).toBe(GOOD.readability);
    expect(row?.errorCode).toBeNull();
    expect(row?.errorMessage).toBeNull();
    expect(row?.preprocessedPhotoId).toBe(pre.id);
    expect(row?.finishedAt).not.toBeNull();

    const call = arkStub.extractAnchor.mock.calls[0]?.[0] as AnchorExtractInput;
    expect(call.systemPrompt).toBe(ANCHOR_V1_SYSTEM_PROMPT);
    expect(call.images).toHaveLength(1);
    expect(arkStub.extractAnchor).toHaveBeenCalledTimes(1);
  });

  it('`features` 多一个键 → 成功且落库 `features_json` 恰 12 键（`.strip()`）', async () => {
    const { original, pre } = await seedPair(GOOD);
    const anchorId = queuedAnchor([original.id], pre.id);
    arkStub.extractAnchor.mockResolvedValue(
      result({ features: { ...fixture.features, extra: '多余键' } as unknown as AnchorFeatures }),
    );

    await run(anchorId);

    expect(findById(anchorId)?.status).toBe('succeeded');
    const stored = storedFeatures(anchorId);
    expect(Object.keys(stored)).toHaveLength(12);
    expect(stored.extra).toBeUndefined();
  });

  it('空串 / 缺键 / 长度越界 / 词表命中 → failed + PROVIDER_ERROR，不写 anchor_text', async () => {
    const { ageRange, ...missing } = fixture.features;
    void ageRange;
    const cases: Array<Partial<{ anchorText: string; features: AnchorFeatures }>> = [
      { anchorText: '' },
      { features: missing as unknown as AnchorFeatures },
      { anchorText: textOf(ANCHOR_MIN_LENGTH - 1) },
      { anchorText: textOf(ANCHOR_MAX_LENGTH + 1) },
      { anchorText: `慈祥的老年男性${'，五官普通'.repeat(9)}` },
      { anchorText: `不要修饰这张脸的描述${'，保持原样'.repeat(8)}` },
    ];
    for (const over of cases) {
      const { original, pre } = await seedPair(GOOD);
      const anchorId = queuedAnchor([original.id], pre.id);
      arkStub.extractAnchor.mockResolvedValue(result(over));

      await run(anchorId);

      const row = findById(anchorId);
      expect(row?.status).toBe('failed');
      expect(row?.errorCode).toBe('PROVIDER_ERROR');
      expect(row?.errorMessage).not.toBeNull();
      expect(row?.anchorText).toBeNull();
      expect(row?.features).toBeNull();
      expect(row?.finishedAt).not.toBeNull();
    }
  });

  it('上游超时 / 上游错误 → failed + 映射后的错误码', async () => {
    const timeout = await seedPair(GOOD);
    const timeoutId = queuedAnchor([timeout.original.id], timeout.pre.id);
    arkStub.extractAnchor.mockRejectedValue(new ArkUpstreamError({ kind: 'timeout', message: 'aborted' }));
    await run(timeoutId);
    expect(findById(timeoutId)?.errorCode).toBe('PROVIDER_TIMEOUT');

    const upstream = await seedPair(GOOD);
    const upstreamId = queuedAnchor([upstream.original.id], upstream.pre.id);
    arkStub.extractAnchor.mockRejectedValue(
      new ArkUpstreamError({ kind: 'http', httpStatus: 500, message: 'InternalServiceError' }),
    );
    await run(upstreamId);
    expect(findById(upstreamId)?.errorCode).toBe('PROVIDER_ERROR');
  });

  it('§6.1：usable=false / 无脸 / faceCount=2 / readability=0.3 → failed + ANCHOR_LOW_QUALITY，quality_json 非空、不调上游', async () => {
    const bad: Quality[] = [
      { ...GOOD, usable: false, advice: '建议换一张' },
      { ...GOOD, faceDetected: false, faceCount: 0 },
      { ...GOOD, faceCount: 2 },
      { ...GOOD, readability: 0.3 },
    ];
    for (const quality of bad) {
      const { original, pre } = await seedPair(quality);
      const anchorId = queuedAnchor([original.id], pre.id);

      await run(anchorId);

      const row = findById(anchorId);
      expect(row?.status).toBe('failed');
      expect(row?.errorCode).toBe('ANCHOR_LOW_QUALITY');
      expect(row?.quality).not.toBeNull();
      expect(row?.anchorText).toBeNull();
    }
    expect(arkStub.extractAnchor).not.toHaveBeenCalled();
  });

  it('`quality_json` 为空时补算一次并回写（§3）', async () => {
    const { original, pre } = await seedPair(null);
    const anchorId = queuedAnchor([original.id], pre.id);

    await run(anchorId);

    const stored = getDb().prepare('SELECT quality_json FROM photos WHERE id = ?').get(pre.id) as {
      quality_json: string | null;
    };
    expect(stored.quality_json).not.toBeNull();
    const row = findById(anchorId);
    expect(row?.quality).not.toBeNull();
    // 纯色测试图没有人脸 → 前置判定直接终止，不浪费一次生成。
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('ANCHOR_LOW_QUALITY');
    expect(arkStub.extractAnchor).not.toHaveBeenCalled();
  });

  it('`prompt_version` 未注册 → failed + INTERNAL，不调上游（§5.3 步骤 1）', async () => {
    const { original, pre } = await seedPair(GOOD);
    const anchorId = queuedAnchor([original.id], pre.id, { promptVersion: 'anchor-v99' });

    await run(anchorId);

    const row = findById(anchorId);
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('INTERNAL');
    expect(arkStub.extractAnchor).not.toHaveBeenCalled();
  });

  it('claim 失败（行已是 succeeded）→ 直接返回，不产生任何写、不调上游', async () => {
    const { original, pre } = await seedPair(GOOD);
    const anchorId = queuedAnchor([original.id], pre.id);
    getDb()
      .prepare(
        `UPDATE identity_anchors SET status='succeeded', anchor_text=@text, features_json=@features,
                finished_at=@at WHERE id=@id`,
      )
      .run({
        id: anchorId,
        text: fixture.anchorText,
        features: JSON.stringify(fixture.features),
        at: '2026-01-01T00:00:00.000Z',
      });
    const before = getDb()
      .prepare(
        'SELECT status, attempt, anchor_text, features_json, error_code, finished_at, quality_json FROM identity_anchors WHERE id = ?',
      )
      .get(anchorId);

    await run(anchorId);

    const after = getDb()
      .prepare(
        'SELECT status, attempt, anchor_text, features_json, error_code, finished_at, quality_json FROM identity_anchors WHERE id = ?',
      )
      .get(anchorId);
    expect(after).toEqual(before);
    expect(arkStub.extractAnchor).not.toHaveBeenCalled();
  });

  it('§5.4：N=5 张图按 `input_photo_ids` 顺序组装送图清单', async () => {
    const pairs = [];
    for (let i = 0; i < 5; i += 1) pairs.push(await seedPair(GOOD));
    const anchorId = queuedAnchor(
      pairs.map((pair) => pair.original.id),
      pairs[0]?.pre.id ?? null,
    );
    arkStub.extractAnchor.mockResolvedValue(result());

    await run(anchorId);

    const call = arkStub.extractAnchor.mock.calls[0]?.[0] as AnchorExtractInput;
    expect(call.images).toHaveLength(5);
    const expected: string[] = [];
    for (const pair of pairs) {
      expected.push((await getStorage().read(pair.pre.storageKey)).toString('base64'));
    }
    expect(call.images.map((img) => img.base64)).toEqual(expected);
    expect(call.images.every((img) => img.mime === 'image/jpeg')).toBe(true);
    expect(findById(anchorId)?.status).toBe('succeeded');
  });

  it('数据异常：`input_photo_ids` 超过 5 张 → failed + INTERNAL（端点已挡 400）', async () => {
    const pairs = [];
    for (let i = 0; i < 6; i += 1) pairs.push(await seedPair(GOOD));
    const anchorId = queuedAnchor(
      pairs.map((pair) => pair.original.id),
      pairs[0]?.pre.id ?? null,
    );

    await run(anchorId);

    expect(findById(anchorId)?.errorCode).toBe('INTERNAL');
    expect(arkStub.extractAnchor).not.toHaveBeenCalled();
  });

  it('不存在的锚点 → 直接返回，不抛错（handler 不得把异常抛给 worker）', async () => {
    await expect(run(999999)).resolves.toBeUndefined();
  });
});

describe('E2E-02 · fixture 的 anchorText 落在 60–120 字符窗口内', () => {
  it('fixture 原样与 mock 的年龄替换后都在窗口内且能过解析', () => {
    expect(fixture.anchorText.length).toBeGreaterThanOrEqual(ANCHOR_MIN_LENGTH);
    expect(fixture.anchorText.length).toBeLessThanOrEqual(ANCHOR_MAX_LENGTH);
    const replayed = fixture.anchorText.replace(/\d+\s*岁/, '63 岁');
    expect(replayed.length).toBeGreaterThanOrEqual(ANCHOR_MIN_LENGTH);
    expect(replayed.length).toBeLessThanOrEqual(ANCHOR_MAX_LENGTH);
    expect(parseAnchorResponse(JSON.stringify({ anchor: replayed, features: fixture.features })).ok).toBe(true);
  });

  it('`anchor-extract-fail.json` 是 `usable=false` 的低质量样本', () => {
    expect(failFixture.quality.usable).toBe(false);
  });
});

describe('§5.4 · messages 组装（RealArkProvider，N=5）', () => {
  it('content 固定为「1 段 text → 5 张 image_url」，顺序即入参顺序', async () => {
    const images = Array.from({ length: 5 }, (_, i) => ({ mime: 'image/jpeg', base64: `b64-${i}` }));
    let captured: { messages: Array<{ role: string; content: unknown }> } | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      captured = JSON.parse(init?.body ?? '{}') as typeof captured;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ anchor: fixture.anchorText, features: fixture.features }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const extracted = await new RealArkProvider().extractAnchor({ images, systemPrompt: 'sys' });
      expect(JSON.parse(extracted.raw)).toMatchObject({ anchor: fixture.anchorText });
    } finally {
      global.fetch = originalFetch;
    }

    const content = (captured as unknown as { messages: Array<{ content: unknown }> }).messages[1]
      ?.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(6);
    expect(content[0]?.type).toBe('text');
    expect(content.slice(1).map((part) => (part.image_url as { url: string }).url)).toEqual(
      images.map((img) => `data:${img.mime};base64,${img.base64}`),
    );
  });
});
