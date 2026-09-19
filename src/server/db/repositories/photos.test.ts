import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../connection';
import { runMigrations } from '../migrate';
import { runSeed } from '../seed';
import { nowIso } from '../../domain/time';
import {
  findActiveOriginalBySha256,
  findActivePhotoForUser,
  findPhotoForUser,
  findPreprocessedBySource,
  insertPhoto,
  listActivePhotosByIds,
  listActivePhotosByUser,
  softDeletePhoto,
  type NewPhoto,
} from './photos';

/**
 * `photos` repository 语义（`docs/prd/modules/M01-照片资产与存储.md` §5、§6.3）。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-photosrepo-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  closeDb();
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

let seq = 0;
const newPhoto = (over: Partial<NewPhoto> = {}): NewPhoto => ({
  userId: 1,
  kind: 'original',
  storageKey: `u1/key-${(seq += 1)}.jpg`,
  mime: 'image/jpeg',
  bytes: 100,
  width: 10,
  height: 10,
  sha256: `sha-${seq}`,
  sourcePhotoId: null,
  qualityJson: null,
  createdAt: nowIso(),
  ...over,
});

describe('归属与软删条件', () => {
  it('findActivePhotoForUser 同时过滤 user_id 与 deleted_at', () => {
    const photo = insertPhoto(newPhoto());
    expect(findActivePhotoForUser(photo.id, 1)?.id).toBe(photo.id);
    expect(findActivePhotoForUser(photo.id, 2)).toBeNull(); // 他人
    expect(findActivePhotoForUser(photo.id, 1)?.storageKey).toBe(photo.storageKey);
  });

  it('softDeletePhoto 返回 changes；findPhotoForUser 不看软删、findActive 看', () => {
    const photo = insertPhoto(newPhoto());
    expect(softDeletePhoto(photo.id, nowIso())).toBe(1);
    expect(softDeletePhoto(photo.id, nowIso())).toBe(0); // 已删，幂等
    expect(findActivePhotoForUser(photo.id, 1)).toBeNull();
    expect(findPhotoForUser(photo.id, 1)?.deletedAt).not.toBeNull();
    expect(findPhotoForUser(photo.id, 2)).toBeNull();
  });
});

describe('去重只认 original', () => {
  it('findActiveOriginalBySha256 命中 original、忽略 preprocessed / 已软删', () => {
    const original = insertPhoto(newPhoto({ sha256: 'dup-sha' }));
    expect(findActiveOriginalBySha256(1, 'dup-sha')?.id).toBe(original.id);

    insertPhoto(newPhoto({ kind: 'preprocessed', sha256: 'dup-sha', sourcePhotoId: original.id }));
    expect(findActiveOriginalBySha256(1, 'dup-sha')?.id).toBe(original.id);

    softDeletePhoto(original.id, nowIso());
    expect(findActiveOriginalBySha256(1, 'dup-sha')).toBeNull();
  });
});

describe('预处理器与列表读取', () => {
  it('findPreprocessedBySource 取最新未软删', () => {
    const original = insertPhoto(newPhoto({ kind: 'original' }));
    expect(findPreprocessedBySource(original.id)).toBeNull();
    const first = insertPhoto(newPhoto({ kind: 'preprocessed', sourcePhotoId: original.id }));
    const second = insertPhoto(newPhoto({ kind: 'preprocessed', sourcePhotoId: original.id }));
    expect(findPreprocessedBySource(original.id)?.id).toBe(second.id);
    softDeletePhoto(second.id, nowIso());
    expect(findPreprocessedBySource(original.id)?.id).toBe(first.id);
  });

  it('listActivePhotosByIds / listActivePhotosByUser 过滤软删与他人', () => {
    const a = insertPhoto(newPhoto());
    const b = insertPhoto(newPhoto());
    const c = insertPhoto(newPhoto());
    softDeletePhoto(c.id, nowIso());
    const ids = listActivePhotosByIds(1, [a.id, b.id, c.id]).map((p) => p.id);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
    expect(listActivePhotosByIds(1, [])).toEqual([]);
    expect(listActivePhotosByIds(2, [a.id])).toEqual([]);
    expect(listActivePhotosByUser(1, { limit: 100 }).some((p) => p.id === c.id)).toBe(false);
  });
});
