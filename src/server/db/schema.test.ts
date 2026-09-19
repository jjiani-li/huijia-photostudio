import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from './connection';
import { runMigrations } from './migrate';
import { runSeed } from './seed';

/**
 * 数据层断言：`DB-01`–`DB-05`、`DB-08`（`docs/prd/spec/07-验收标准.md` §2.1）。
 * 在临时库上跑真实的 `runMigrations` + `runSeed`，不碰开发库。
 */
const EXPECTED_TABLES = [
  'schema_migrations',
  'users',
  'login_codes',
  'sessions',
  'photos',
  'identity_anchors',
  'prompt_reverse_jobs',
  'eras',
  'scenes',
  'era_scene_profiles',
  'generations',
  'generation_results',
  'consents',
  'usage_counters',
  'content_reviews',
  'audit_logs',
];

const MIN_SIZE_PIXELS = 3_686_400;
const CONFIDENCE_HINT_THRESHOLD = 0.6;
const NEGATION_RE = /不要|禁止|不得出现|no\s/;

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-db-'));
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

const tableNames = (): string[] =>
  (
    getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .sort();

describe('DB-01 表集合', () => {
  it('sqlite_master 恰含 16 张表', () => {
    expect(tableNames()).toEqual([...EXPECTED_TABLES].sort());
  });
});

describe('DB-02 配置资产计数', () => {
  it('eras=4 / scenes=5 / era_scene_profiles=20', () => {
    expect(runSeed()).toEqual({ eras: 4, scenes: 5, profiles: 20 });
  });

  it('重复 migrate / seed 幂等', () => {
    expect(runMigrations().applied).toEqual([]);
    const first = runSeed();
    expect(first).toEqual(runSeed());
    expect(tableNames()).toEqual([...EXPECTED_TABLES].sort());
  });
});

describe('DB-03 年代约束片段正向化', () => {
  it('每个 constraint_pack 非空且不含否定词', () => {
    const rows = getDb()
      .prepare('SELECT code, constraint_pack FROM eras')
      .all() as { code: string; constraint_pack: string }[];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.constraint_pack.length).toBeGreaterThan(0);
      expect(NEGATION_RE.test(row.constraint_pack), `${row.code} 含否定词`).toBe(false);
    }
  });
});

describe('DB-04 组合置信度', () => {
  it('confidence ∈ [0,1]；低置信（< 0.6）恰好 5 组', () => {
    const rows = getDb().prepare('SELECT era_code, scene_id, confidence FROM era_scene_profiles').all() as {
      era_code: string;
      scene_id: number;
      confidence: number;
    }[];
    expect(rows).toHaveLength(20);
    for (const row of rows) {
      expect(row.confidence).toBeGreaterThanOrEqual(0);
      expect(row.confidence).toBeLessThanOrEqual(1);
    }
    expect(rows.filter((row) => row.confidence < CONFIDENCE_HINT_THRESHOLD)).toHaveLength(5);
  });
});

describe('DB-05 default_size 尺寸下限', () => {
  it('每个年代的 default_size 总像素 ≥ 3,686,400', () => {
    const rows = getDb().prepare('SELECT code, default_size FROM eras').all() as {
      code: string;
      default_size: string;
    }[];
    for (const row of rows) {
      const match = /^(\d+)x(\d+)$/.exec(row.default_size);
      expect(match, `${row.code} 的 default_size 形状非法`).not.toBeNull();
      const [, w, h] = match as RegExpExecArray;
      expect(Number(w) * Number(h)).toBeGreaterThanOrEqual(MIN_SIZE_PIXELS);
    }
  });
});

describe('DB-08 配置表只由种子写入', () => {
  it('业务代码中不存在对 eras / scenes / era_scene_profiles 的写语句', () => {
    const writeRe =
      /\b(insert\s+into|update|delete\s+from|replace\s+into)\s+(eras|scenes|era_scene_profiles)\b/i;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const rel = path.relative(process.cwd(), full).split(path.sep).join('/');
          if (rel === 'src/server/db/seed.ts') continue; // 种子的唯一写入路径
          if (writeRe.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
        }
      }
    };
    for (const root of ['src', 'app']) walk(path.join(process.cwd(), root));
    expect(offenders).toEqual([]);
  });
});

describe('DEV_USER 种子', () => {
  it('已实名，供 M1/M2 的受保护端点使用', () => {
    const row = getDb()
      .prepare('SELECT nickname, real_name, id_hash, verified_at FROM users WHERE id = 1')
      .get() as { nickname: string; real_name: string | null; id_hash: string | null; verified_at: string | null };
    expect(row.nickname).toBe('DEV_USER');
    expect(row.real_name).not.toBeNull();
    expect(row.id_hash).not.toBeNull();
    expect(row.verified_at).not.toBeNull();
  });
});
