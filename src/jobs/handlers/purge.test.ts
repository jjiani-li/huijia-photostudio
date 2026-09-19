import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../server/db/connection';
import { runMigrations } from '../../server/db/migrate';
import { runSeed } from '../../server/db/seed';
import { getStorage, resetStorage } from '../../server/storage';
import { insertPhoto } from '../../server/db/repositories/photos';
import { insert as insertReverseJob } from '../../server/db/repositories/promptReverseJobs';
import { nowIso } from '../../server/domain/time';
import { PURGE_GRACE_MINUTES, runPurge } from './purge';

/**
 * `runPurge()` 的单测（`docs/prd/modules/M08-账号历史与彻底删除.md` §5.3）：
 * 文件 + 行一起消失、审计 `photo.purge`、未到期的不动、缺文件视为成功、
 * 连续两次清理第二次全零（`CMP-05` 的 A 层旁证）。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-purge-'));
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

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

/** 落一张带真实磁盘文件的软删照片；`deletedAt` 早于宽限期才可被清理。 */
const makeSoftDeleted = async (deletedAt: string): Promise<number> => {
  const key = `u1/purge-${Math.random().toString(16).slice(2)}.jpg`;
  const buffer = Buffer.from('purge-sample');
  await getStorage().save(key, buffer);
  const photo = insertPhoto({
    userId: 1,
    kind: 'original',
    storageKey: key,
    mime: 'image/jpeg',
    bytes: buffer.length,
    width: 10,
    height: 10,
    sha256: Math.random().toString(16).slice(2).padEnd(64, '0'),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  });
  getDb().prepare('UPDATE photos SET deleted_at = ? WHERE id = ?').run(deletedAt, photo.id);
  return photo.id;
};

const exists = (id: number): boolean =>
  getDb().prepare('SELECT 1 FROM photos WHERE id = ?').get(id) !== undefined;

describe('runPurge（§5.3）', () => {
  it('到期照片：磁盘文件与 photos 行物理消失、写 photo.purge 审计；未到期的不动', async () => {
    const expired = await makeSoftDeleted(HOUR_AGO);
    const fresh = await makeSoftDeleted(nowIso());
    const keyRow = getDb().prepare('SELECT storage_key FROM photos WHERE id = ?').get(expired) as {
      storage_key: string;
    };
    const auditBefore = (
      getDb().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'photo.purge'").get() as { n: number }
    ).n;

    const result = await runPurge();

    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(1);
    expect(result.failed).toBe(0);
    expect(exists(expired)).toBe(false);
    expect(fs.existsSync(getStorage().resolveAbs(keyRow.storage_key))).toBe(false);
    expect(exists(fresh)).toBe(true);
    const audits = getDb()
      .prepare("SELECT meta_json FROM audit_logs WHERE action = 'photo.purge' AND target = ?")
      .all(`photo:${expired}`) as { meta_json: string | null }[];
    expect(audits).toHaveLength(1);
    expect(auditBefore).toBeGreaterThanOrEqual(0);
  });

  it('连续两次 runPurge()，第二次全零（CMP-05）', async () => {
    await makeSoftDeleted(HOUR_AGO);
    const first = await runPurge();
    expect(first.purged).toBeGreaterThanOrEqual(1);
    const second = await runPurge();
    expect(second).toEqual({ scanned: 0, purged: 0, failed: 0, deletedResults: 0 });
  });

  it('文件缺失视为成功（幂等）；连带删掉该批次的 prompt_reverse_jobs 行', async () => {
    const id = await makeSoftDeleted(HOUR_AGO);
    const keyRow = getDb().prepare('SELECT storage_key FROM photos WHERE id = ?').get(id) as {
      storage_key: string;
    };
    fs.rmSync(getStorage().resolveAbs(keyRow.storage_key), { force: true });
    insertReverseJob({ userId: 1, sourcePhotoId: id, model: 'vision', status: 'queued', attempt: 0, createdAt: nowIso() });

    const result = await runPurge();

    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(exists(id)).toBe(false);
    const jobs = getDb()
      .prepare('SELECT COUNT(*) AS n FROM prompt_reverse_jobs WHERE source_photo_id = ?')
      .get(id) as { n: number };
    expect(jobs.n).toBe(0);
  });
});

describe('常量（§5.3）', () => {
  it('PURGE_GRACE_MINUTES 恒为 10', () => {
    expect(PURGE_GRACE_MINUTES).toBe(10);
  });
});
