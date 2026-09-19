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
import {
  findById,
  insert as insertReverseJob,
  markTerminalFailure,
} from '../../server/db/repositories/promptReverseJobs';
import { nowIso } from '../../server/domain/time';
import { readPromptReverseFixture } from '../../server/ark/fixtures';
import type { PromptReverseResult } from '../../server/ark/types';
import { promptReverseDetailSchema } from '../../shared/types';
import { stripFence } from './anchorExtract';
import {
  parseReverseResponse,
  reversePromptHandler,
  settleReverseFailure,
  type ReverseDomain,
} from './reversePrompt';

/**
 * `reversePromptHandler` 的单元测试（`docs/prd/modules/M09-图片反推提示词.md` §9 列出的全部用例）：
 * 结构校验失败、五键缺失、减龄 / 美化词命中、推荐值越界置 `null`，以及 §5 的状态机与落库。
 * `getArk()` 用桩替换：本文件断言的是解析与终态写入，不是 fixture 回放本身（后者见 `ark/mock.test.ts`）。
 */
const { arkStub } = vi.hoisted(() => ({
  arkStub: { reversePrompt: vi.fn(), extractAnchor: vi.fn(), generateImage: vi.fn() },
}));

vi.mock('../../server/ark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/ark')>();
  return { ...actual, getArk: () => arkStub };
});

const fixture = readPromptReverseFixture();
const GOOD = JSON.parse(fixture.choices[0]!.message.content) as Record<string, unknown>;
const MODEL = fixture.model;

/** 取值域：`E1`–`E4` 与场景 1–5（测试用字面量，不走库）。 */
const domain: ReverseDomain = {
  eraCodeAllowed: (code) => ['E1', 'E2', 'E3', 'E4'].includes(code),
  sceneIdAllowed: (id) => id >= 1 && id <= 5,
};

const raw = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...GOOD, ...over });

let tmpDir: string;
let seq = 0;
const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex');

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-reverse-handler-'));
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
  arkStub.reversePrompt.mockReset();
  arkStub.extractAnchor.mockReset();
  arkStub.generateImage.mockReset();
});

/** 一张「文件真实存在」的源图（handler 要读盘取 Base64）。 */
const seedPhoto = async (userId = 1): Promise<number> => {
  seq += 1;
  const buffer = await sharp({
    create: { width: 64 + seq, height: 48 + seq, channels: 3, background: { r: 200, g: 190, b: 180 } },
  })
    .jpeg()
    .toBuffer();
  const key = buildKey(userId, 'jpg');
  const saved = await getStorage().save(key, buffer);
  return insertPhoto({
    userId,
    kind: 'original',
    storageKey: key,
    mime: 'image/jpeg',
    bytes: saved.bytes,
    width: 64 + seq,
    height: 48 + seq,
    sha256: sha(`reverse-${seq}`),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  }).id;
};

const queuedJob = (sourcePhotoId: number, userId = 1, attempt = 0): number =>
  insertReverseJob({
    userId,
    sourcePhotoId,
    model: MODEL,
    status: 'queued',
    attempt,
    createdAt: nowIso(),
  }).id;

const resultOf = (content: string): PromptReverseResult => ({ raw: content, model: MODEL });
const run = (jobId: number): Promise<void> => reversePromptHandler({ jobId });

describe('§5.4 · 容错解析五步', () => {
  it('第 1 步：剥 ```json 包裹后解析成功', () => {
    const wrapped = `\`\`\`json\n${raw()}\n\`\`\``;
    expect(stripFence(wrapped)).toBe(raw());
    expect(parseReverseResponse(wrapped, domain)).toMatchObject({ ok: true, resultPrompt: GOOD.result_prompt });
  });

  it('第 2 步：空串 / 非法 JSON / 数组 / null → 失败', () => {
    for (const bad of ['', '   ', '不是 JSON', '[1,2]', '"文本"', 'null']) {
      expect(parseReverseResponse(bad, domain)).toMatchObject({ ok: false });
    }
  });

  it('第 3 步：五键缺一 → 失败；`result_prompt` 缺 / 空串 → 失败', () => {
    for (const key of ['scene', 'lighting', 'era', 'wardrobe', 'composition']) {
      const missing: Record<string, unknown> = { ...GOOD };
      delete missing[key];
      expect(parseReverseResponse(JSON.stringify(missing), domain), key).toMatchObject({ ok: false });
    }
    for (const prompt of [undefined, '']) {
      const over = prompt === undefined ? { result_prompt: undefined } : { result_prompt: prompt };
      expect(parseReverseResponse(raw(over), domain)).toMatchObject({ ok: false });
    }
  });

  it('第 3 步：多余键被丢弃（`result` 恰好五键）', () => {
    const parsed = parseReverseResponse(raw({ extra: '未声明的键' }), domain);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys(parsed.result).sort()).toEqual(['composition', 'era', 'lighting', 'scene', 'wardrobe']);
      expect(promptReverseDetailSchema.safeParse(parsed.result).success).toBe(true);
    }
  });

  it('第 4 步：推荐值越界 / 类型不符 / 缺键 → 置 null，不判失败', () => {
    for (const over of [
      { suggest_era_code: 'E9' },
      { suggest_era_code: 2 },
      { suggest_era_code: undefined },
      { suggest_scene_id: 999 },
      { suggest_scene_id: '3' },
      { suggest_scene_id: 3.5 },
      { suggest_scene_id: undefined },
    ]) {
      const parsed = parseReverseResponse(raw(over), domain);
      expect(parsed.ok, JSON.stringify(over)).toBe(true);
      if (parsed.ok) {
        if ('suggest_era_code' in over) expect(parsed.suggestEraCode).toBeNull();
        if ('suggest_scene_id' in over) expect(parsed.suggestSceneId).toBeNull();
      }
    }
  });

  it('第 4 步：`null` 本身也合法（无法判断）', () => {
    const parsed = parseReverseResponse(raw({ suggest_era_code: null, suggest_scene_id: null }), domain);
    expect(parsed).toMatchObject({ ok: true, suggestEraCode: null, suggestSceneId: null });
  });

  it('第 5 步：减龄 / 美化 / 换脸词命中 → 失败（五个字段与 result_prompt 都扫）', () => {
    const hits: Array<Record<string, unknown>> = [
      { scene: '人物面容显年轻，背景是室内堂屋' },
      { lighting: '光线柔和，面容温和' },
      { era: '八十年代，人物换脸后毫无皱纹' },
      { wardrobe: '穿着中山装，看上去保养得好' },
      { composition: '中景构图，人物慈祥' },
      { result_prompt: '黑白老照片，人物减龄处理' },
    ];
    for (const over of hits) {
      expect(parseReverseResponse(raw(over), domain), Object.keys(over)[0]).toMatchObject({ ok: false });
    }
  });
});

describe('§5 · handler 状态机与落库', () => {
  it('成功：写 succeeded + 五键 result_json + result_prompt + 两个推荐值', async () => {
    const jobId = queuedJob(await seedPhoto());
    arkStub.reversePrompt.mockResolvedValue(resultOf(raw()));

    await run(jobId);

    const row = findById(jobId);
    expect(row?.status).toBe('succeeded');
    expect(row?.result).toEqual(promptReverseDetailSchema.parse(parsedFiveKeys()));
    expect(row?.resultPrompt).toBe(GOOD.result_prompt);
    expect(row?.suggestEraCode).toBe('E2');
    expect(row?.suggestSceneId).toBe(3);
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.errorCode).toBeNull();
    expect(arkStub.reversePrompt).toHaveBeenCalledTimes(1);
    // messages 组装：system 用字符串、user 的 text 在图片之前，固定 1 张图（`modules/M09` §5.1）。
    const input = arkStub.reversePrompt.mock.calls[0]?.[0] as { images: unknown[]; systemPrompt: string };
    expect(input.images).toHaveLength(1);
    expect(input.systemPrompt).toContain('suggest_scene_id');
  });

  it('推荐值越界：仍成功，两列落 NULL', async () => {
    const jobId = queuedJob(await seedPhoto());
    arkStub.reversePrompt.mockResolvedValue(
      resultOf(raw({ suggest_era_code: 'E99', suggest_scene_id: 12345 })),
    );

    await run(jobId);

    const row = findById(jobId);
    expect(row?.status).toBe('succeeded');
    expect(row?.suggestEraCode).toBeNull();
    expect(row?.suggestSceneId).toBeNull();
  });

  it('claim 失败：已 running 的行不再执行，产物保持原样', async () => {
    const jobId = queuedJob(await seedPhoto());
    getDb().prepare("UPDATE prompt_reverse_jobs SET status = 'running' WHERE id = ?").run(jobId);

    await run(jobId);

    expect(arkStub.reversePrompt).not.toHaveBeenCalled();
    expect(findById(jobId)?.status).toBe('running');
  });

  it('解析失败：零产出 + 瞬时错误 + attempt<1 → 回 queued 且 attempt=1；再失败则落 failed', async () => {
    const jobId = queuedJob(await seedPhoto());
    arkStub.reversePrompt.mockResolvedValue(resultOf('上游正文不是 JSON：模型跑题了'));

    await run(jobId);

    const requeued = findById(jobId);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.attempt).toBe(1);
    expect(requeued?.errorCode).toBe('PROVIDER_ERROR');
    // `error_message` 是文案而不是模型原文（`modules/M09` §5.4：原文只进 logger.warn）。
    expect(requeued?.errorMessage).toBe('生成服务暂时不可用，请稍后重试');
    expect(requeued?.errorMessage).not.toContain('模型跑题了');

    await run(jobId);

    const failed = findById(jobId);
    expect(failed?.status).toBe('failed');
    expect(failed?.attempt).toBe(1);
    expect(failed?.finishedAt).not.toBeNull();
  });

  it('词表命中：不落 succeeded，按 PROVIDER_ERROR 处置', async () => {
    const jobId = queuedJob(await seedPhoto());
    arkStub.reversePrompt.mockResolvedValue(resultOf(raw({ era: '八十年代，人物显年轻' })));

    await run(jobId);

    const row = findById(jobId);
    expect(row?.status).toBe('queued');
    expect(row?.errorCode).toBe('PROVIDER_ERROR');
    expect(row?.resultPrompt).toBeNull();
  });

  it('源照片缺失（入队后被软删）：落 failed + INTERNAL，不抛给 worker', async () => {
    const jobId = queuedJob(await seedPhoto());
    getDb().prepare('UPDATE photos SET deleted_at = ? WHERE id = ?').run(nowIso(), findById(jobId)?.sourcePhotoId);

    await expect(run(jobId)).resolves.toBeUndefined();

    const row = findById(jobId);
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('INTERNAL');
    expect(row?.errorMessage).not.toBeNull();
  });

  it('任务行不存在：静默返回', async () => {
    await expect(run(999_999)).resolves.toBeUndefined();
  });
});

describe('§4.6 · 失败处置与超时兜底', () => {
  it('不可重试的上游错误（ModelNotOpen 落 PROVIDER_ERROR 但标 ❌）直接落 failed', () => {
    const jobId = queuedJob(1);
    const outcome = settleReverseFailure(
      { id: jobId, attempt: 0 },
      { code: 'PROVIDER_ERROR', retryable: false, raw: 'ModelNotOpen' },
    );
    expect(outcome).toBe('failed');
    expect(findById(jobId)?.status).toBe('failed');
  });

  it('可重试但 attempt 已用掉 → 落 failed（attempt 不变）', () => {
    const jobId = queuedJob(1, 1, 1);
    const outcome = settleReverseFailure(
      { id: jobId, attempt: 1 },
      { code: 'PROVIDER_TIMEOUT', retryable: true, raw: 'timeout' },
    );
    expect(outcome).toBe('failed');
    expect(findById(jobId)?.attempt).toBe(1);
  });

  it('超时兜底只对仍 running 的行生效', async () => {
    const { failTimedOutReverseJob } = await import('./reversePrompt');
    const jobId = queuedJob(1);
    markTerminalFailure(jobId, 'INTERNAL', '已落终态', nowIso());

    failTimedOutReverseJob(jobId);

    const row = findById(jobId);
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('INTERNAL');
  });
});

/** `GOOD` 的五个描述键（用于比对落库的 `result_json`）。 */
function parsedFiveKeys(): Record<string, string> {
  return {
    scene: GOOD.scene as string,
    lighting: GOOD.lighting as string,
    era: GOOD.era as string,
    wardrobe: GOOD.wardrobe as string,
    composition: GOOD.composition as string,
  };
}
