import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { insertPhoto } from '../db/repositories/photos';
import {
  insert as insertReverseJob,
  markTerminalFailure,
} from '../db/repositories/promptReverseJobs';
import { nowIso } from './time';
import { AppError } from './errors';
import { createReverseJob, readReverseJobForUser, toPromptReverseJobDto } from './reverseService';

/**
 * `POST` / `GET /api/prompt-reverse-jobs` 的领域层（`docs/prd/modules/M09-图片反推提示词.md` §4、§7）：
 * 归属与 `kind` 校验、`queued` 行落库、DTO 投影（非终态一律 `null`、`failed` 时 `error` 非空）。
 */
let tmpDir: string;
let seq = 0;
const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex');

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-reverse-service-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  process.env.STORAGE_DIR = path.join(tmpDir, 'storage');
  closeDb();
  runMigrations();
  runSeed();
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.STORAGE_DIR;
});

const insertPhotoOfKind = (
  kind: 'original' | 'preprocessed' | 'generated',
  userId = 1,
  deleted = false,
): number => {
  seq += 1;
  const photo = insertPhoto({
    userId,
    kind,
    storageKey: `u${userId}/reverse-service-${seq}.jpg`,
    mime: 'image/jpeg',
    bytes: 10,
    width: 100,
    height: 80,
    sha256: sha(`service-${seq}`),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  });
  if (deleted) getDb().prepare('UPDATE photos SET deleted_at = ? WHERE id = ?').run(nowIso(), photo.id);
  return photo.id;
};

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'NO_THROW';
  } catch (err) {
    return err instanceof AppError ? err.code : `ERROR:${String(err)}`;
  }
};

describe('createReverseJob', () => {
  it('`original` 与 `preprocessed` 都可入队：建 `queued` 行、产物字段全 null、model 取当前值', () => {
    const savedModel = process.env.ARK_VISION_MODEL;
    delete process.env.ARK_VISION_MODEL;
    try {
      for (const kind of ['original', 'preprocessed'] as const) {
        const photoId = insertPhotoOfKind(kind);
        const job = createReverseJob({ userId: 1, photoId });

        expect(job.status).toBe('queued');
        expect(job.photoId).toBe(photoId);
        expect(job.model).toBe('doubao-seed-2-1-turbo-260628');
        expect(job.resultJson).toBeNull();
        expect(job.resultPrompt).toBeNull();
        expect(job.suggestEraCode).toBeNull();
        expect(job.suggestSceneId).toBeNull();
        expect(job.error).toBeNull();
        expect(job.finishedAt).toBeNull();

        const row = getDb()
          .prepare('SELECT status, attempt, started_at FROM prompt_reverse_jobs WHERE id = ?')
          .get(job.id) as { status: string; attempt: number; started_at: string | null };
        expect(row).toEqual({ status: 'queued', attempt: 0, started_at: null });
      }
    } finally {
      if (savedModel !== undefined) process.env.ARK_VISION_MODEL = savedModel;
    }
  });

  it('每次调用建新行（重复反推不覆盖旧行）', () => {
    const photoId = insertPhotoOfKind('original');
    const first = createReverseJob({ userId: 1, photoId });
    const second = createReverseJob({ userId: 1, photoId });
    expect(second.id).not.toBe(first.id);
    expect(readReverseJobForUser(1, first.id).status).toBe('queued');
  });

  it('不存在 / 属他人 / 已软删 → 404 NOT_FOUND（不返回 403）', () => {
    const otherUsers = insertPhotoOfKind('original', 999);
    const softDeleted = insertPhotoOfKind('original', 1, true);
    for (const photoId of [999_999, otherUsers, softDeleted]) {
      expect(codeOf(() => createReverseJob({ userId: 1, photoId }))).toBe('NOT_FOUND');
    }
  });

  it('`kind=\'generated\'` → 400 INVALID_PARAM（防链式自举）', () => {
    const photoId = insertPhotoOfKind('generated');
    let details: unknown;
    try {
      createReverseJob({ userId: 1, photoId });
    } catch (err) {
      details = err instanceof AppError ? err.details : null;
    }
    expect(codeOf(() => createReverseJob({ userId: 1, photoId }))).toBe('INVALID_PARAM');
    expect(details).toEqual({ fields: { photoId: ['结果图不能作为反推输入（防链式自举）'] } });
  });

  it('不写 `identity_anchors`、不写 `usage_counters`（`modules/M09` §1）', () => {
    const before = {
      anchors: (getDb().prepare('SELECT COUNT(*) AS n FROM identity_anchors').get() as { n: number }).n,
      usage: (getDb().prepare('SELECT COUNT(*) AS n FROM usage_counters').get() as { n: number }).n,
    };
    createReverseJob({ userId: 1, photoId: insertPhotoOfKind('original') });
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM identity_anchors').get() as { n: number }).n).toBe(
      before.anchors,
    );
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM usage_counters').get() as { n: number }).n).toBe(
      before.usage,
    );
  });
});

describe('readReverseJobForUser / DTO 投影', () => {
  it('不是自己的任务 → 404 NOT_FOUND', () => {
    const job = createReverseJob({ userId: 999, photoId: insertPhotoOfKind('original', 999) });
    expect(codeOf(() => readReverseJobForUser(1, job.id))).toBe('NOT_FOUND');
    expect(readReverseJobForUser(999, job.id).id).toBe(job.id);
  });

  it('`failed` 时 `error` 非空且 `message` 取文案表（不是库里的原文）', () => {
    const job = createReverseJob({ userId: 1, photoId: insertPhotoOfKind('original') });
    markTerminalFailure(job.id, 'PROVIDER_ERROR', '上游原文不该透给用户', nowIso());

    const dto = readReverseJobForUser(1, job.id);
    expect(dto.status).toBe('failed');
    expect(dto.error).toEqual({ code: 'PROVIDER_ERROR', message: '生成服务暂时不可用，请稍后重试' });
    expect(dto.finishedAt).not.toBeNull();
  });

  it('`running`（非终态）时四个产物字段一律 null，即使库里已有半成品', () => {
    const job = insertReverseJob({
      userId: 1,
      sourcePhotoId: insertPhotoOfKind('original'),
      model: 'm',
      status: 'running',
      attempt: 0,
      createdAt: nowIso(),
    });
    getDb()
      .prepare('UPDATE prompt_reverse_jobs SET result_prompt = ? WHERE id = ?')
      .run('半成品，不该透出去', job.id);

    const dto = toPromptReverseJobDto({ ...job, resultPrompt: '半成品，不该透出去' });
    expect(dto.resultJson).toBeNull();
    expect(dto.resultPrompt).toBeNull();
    expect(dto.suggestEraCode).toBeNull();
    expect(dto.suggestSceneId).toBeNull();
  });
});
