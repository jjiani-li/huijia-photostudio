import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { nowIso } from '../domain/time';
import { audit } from './audit';

/**
 * `audit()` 唯一入口的单元形态（`docs/prd/modules/M04-身份确认与授权.md` §9、§8.1 第 ⑦ 条）：
 * `meta` 经 `JSON.stringify` 写入后读回为对象、`target` 形如 `anchor:3`；审计在**调用方的事务内**写入，
 * 事务回滚时无残留行（写入失败**不回吞**，宁可让请求失败也不留半截记录）。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-audit-'));
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

const auditCount = (): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number }).n;

describe('audit()（M04 §9）', () => {
  it('meta 读回为对象、target 原样保留，时间戳用传入的 `at`', () => {
    const at = nowIso();
    const record = audit(
      {
        userId: null,
        action: 'anchor.confirm',
        target: 'anchor:3',
        meta: { attempt: 0, scopes: ['photo_usage'] },
      },
      at,
    );
    expect(record.id).toBeGreaterThan(0);
    expect(record.target).toBe('anchor:3');
    expect(record.createdAt).toBe(at);
    expect(record.meta).toEqual({ attempt: 0, scopes: ['photo_usage'] });
  });

  it('在调用方事务内写入：事务回滚后无残留行，且错误不被回吞', () => {
    const before = auditCount();
    expect(() =>
      getDb()
        .transaction(() => {
          audit({ userId: 1, action: 'photo.upload', target: 'photo:1', meta: {} });
          throw new Error('boom');
        })(),
    ).toThrow('boom');
    expect(auditCount()).toBe(before);
  });
});
