import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { getDay, deduct } from '../db/repositories/usage';
import { AppError } from '../domain/errors';
import { dayKey } from '../domain/time';
import { assertQuotaAvailable, readQuota, rollbackUnproduced } from './quota';

/**
 * 额度的领域封装（`docs/prd/modules/M08-账号历史与彻底删除.md` §3.1、`modules/M06` §5.1 第 7 步、§5.6）：
 * `readQuota` 的算式、`assertQuotaAvailable` 的边界（`SEC-04`）、`rollbackUnproduced` 的回滚与空转。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-quota-'));
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

const setLimit = (limit: number): void => {
  getDb().prepare('UPDATE users SET daily_image_quota = ? WHERE id = 1').run(limit);
};

const codeOf = (fn: () => void): string => {
  try {
    fn();
    return 'NO_THROW';
  } catch (err) {
    return err instanceof AppError ? err.code : `NON_APP_ERROR:${String(err)}`;
  }
};

beforeEach(() => {
  getDb().prepare('DELETE FROM usage_counters').run();
  setLimit(20);
});

describe('readQuota（M08 §3.1）', () => {
  it('形状与算式：day = 今日 UTC 日期，remaining = limit - images（下限 0）', () => {
    setLimit(5);
    expect(readQuota(1)).toEqual({ day: dayKey(), images: 0, limit: 5, remaining: 5 });

    deduct(1, dayKey(), 2);
    expect(readQuota(1)).toEqual({ day: dayKey(), images: 2, limit: 5, remaining: 3 });

    deduct(1, dayKey(), 3);
    expect(readQuota(1)).toEqual({ day: dayKey(), images: 5, limit: 5, remaining: 0 });
  });

  it('超额时 remaining 不为负', () => {
    setLimit(2);
    deduct(1, dayKey(), 3);
    expect(readQuota(1).remaining).toBe(0);
  });

  it('undefined 用户按 limit=0 计（不抛错）', () => {
    expect(readQuota(999999)).toEqual({ day: dayKey(), images: 0, limit: 0, remaining: 0 });
  });
});

describe('assertQuotaAvailable（SEC-04 的边界）', () => {
  it('images + count == limit → 放行；多 1 张 → QUOTA_EXCEEDED', () => {
    setLimit(5);
    deduct(1, dayKey(), 3);
    expect(codeOf(() => assertQuotaAvailable(1, 2))).toBe('NO_THROW');
    expect(codeOf(() => assertQuotaAvailable(1, 3))).toBe('QUOTA_EXCEEDED');
  });

  it('无 usage 行时按 0 计：count <= limit 放行', () => {
    setLimit(2);
    expect(codeOf(() => assertQuotaAvailable(1, 2))).toBe('NO_THROW');
    expect(codeOf(() => assertQuotaAvailable(1, 3))).toBe('QUOTA_EXCEEDED');
  });

  it('抛出的 AppError 状态码为 429（文案与状态取 spec/03 §5）', () => {
    setLimit(0);
    try {
      assertQuotaAvailable(1, 2);
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(429);
    }
  });
});

describe('rollbackUnproduced（M06 §5.6）', () => {
  it('images -= unproduced，generations 计数不回滚', () => {
    deduct(1, dayKey(), 4);
    rollbackUnproduced(1, dayKey(), 1);
    expect(getDay(1, dayKey()).images).toBe(3);
    expect(getDay(1, dayKey()).generations).toBe(1);
  });

  it('unproduced === 0 是空转（不执行语句、值不变）', () => {
    deduct(1, dayKey(), 4);
    rollbackUnproduced(1, dayKey(), 0);
    expect(getDay(1, dayKey()).images).toBe(4);
  });

  it('只在同日那一行生效（跨天完成时不打错行）', () => {
    deduct(1, dayKey(), 4);
    getDb().prepare('INSERT INTO usage_counters (user_id, day, generations, images) VALUES (1, ?, 1, 4)').run('2000-01-01');
    rollbackUnproduced(1, '2000-01-01', 2);
    expect(getDay(1, dayKey()).images).toBe(4);
    expect(getDay(1, '2000-01-01').images).toBe(2);
  });
});
