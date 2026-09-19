/**
 * `pnpm check:acceptance` —— B 层契约与链路检查的执行器（`docs/prd/spec/07-验收标准.md` §3）。
 *
 * 骨架由 `tickets/T01-项目脚手架与本地开发环境.md` 声明；本条先接上数据层（`DB-01`–`DB-05`、`DB-08`，
 * 直接读库、不需 HTTP），`DB-06` / `DB-07` 待 `tickets/T08` 的配置端点与 `/api/health` 接线，
 * HTTP / E2E 用例由 `tickets/T10` / `tickets/T13` / `tickets/T20` 以「修改」方式追加。
 *
 * 输出格式、失败即退出码 1、自带清理见 §3。前置：`pnpm migrate && pnpm seed` 已跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/server/db/connection';

interface CheckResult {
  ok: boolean;
  expected: string;
  actual: string;
}
interface Check {
  id: string;
  dependsOn?: string[];
  run(): CheckResult;
}

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
].sort();

const MIN_SIZE_PIXELS = 3_686_400;
const CONFIDENCE_HINT = 0.6;
const NEGATION_RE = /不要|禁止|不得出现|no\s/;

const count = (table: string): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const scanConfigWrites = (): string[] => {
  const writeRe =
    /\b(insert\s+into|update|delete\s+from|replace\s+into)\s+(eras|scenes|era_scene_profiles)\b/i;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const rel = path.relative(process.cwd(), full).split(path.sep).join('/');
        if (rel === 'src/server/db/seed.ts') continue; // 种子的唯一写入路径
        if (writeRe.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    }
  };
  for (const root of ['src', 'app']) {
    if (fs.existsSync(root)) walk(root);
  }
  return offenders;
};

const checks: Check[] = [
  {
    id: 'DB-01',
    run: () => {
      const actual = (
        getDb()
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      )
        .map((r) => r.name)
        .sort();
      const ok =
        actual.length === EXPECTED_TABLES.length &&
        actual.every((name, i) => name === EXPECTED_TABLES[i]);
      return { ok, expected: '16/16 tables', actual: `${actual.length}/16 tables` };
    },
  },
  {
    id: 'DB-02',
    run: () => {
      const eras = count('eras');
      const scenes = count('scenes');
      const profiles = count('era_scene_profiles');
      return {
        ok: eras === 4 && scenes === 5 && profiles === 20,
        expected: 'eras=4 scenes=5 profiles=20',
        actual: `eras=${eras} scenes=${scenes} profiles=${profiles}`,
      };
    },
  },
  {
    id: 'DB-03',
    run: () => {
      const rows = getDb().prepare('SELECT code, constraint_pack FROM eras').all() as {
        code: string;
        constraint_pack: string;
      }[];
      const bad = rows.filter((r) => r.constraint_pack.length === 0 || NEGATION_RE.test(r.constraint_pack));
      return { ok: bad.length === 0, expected: '0 命中否定词', actual: `${bad.length} 命中` };
    },
  },
  {
    id: 'DB-04',
    run: () => {
      const rows = getDb().prepare('SELECT confidence FROM era_scene_profiles').all() as {
        confidence: number;
      }[];
      const outOfRange = rows.filter((r) => r.confidence < 0 || r.confidence > 1).length;
      const low = rows.filter((r) => r.confidence < CONFIDENCE_HINT).length;
      return {
        ok: outOfRange === 0 && low === 5,
        expected: '全部 ∈[0,1] 且低置信恰 5 组',
        actual: `越界 ${outOfRange}，低置信 ${low} 组`,
      };
    },
  },
  {
    id: 'DB-05',
    run: () => {
      const rows = getDb().prepare('SELECT code, default_size FROM eras').all() as {
        code: string;
        default_size: string;
      }[];
      const bad = rows.filter((r) => {
        const m = /^(\d+)x(\d+)$/.exec(r.default_size);
        return m === null || Number(m[1]) * Number(m[2]) < MIN_SIZE_PIXELS;
      });
      return { ok: bad.length === 0, expected: `全部 ≥ ${MIN_SIZE_PIXELS}`, actual: `${bad.length} 个不达标` };
    },
  },
  {
    id: 'DB-08',
    run: () => {
      const offenders = scanConfigWrites();
      return { ok: offenders.length === 0, expected: '0 命中', actual: `${offenders.length} 命中 ${offenders.join(',')}` };
    },
  },
];

/** 自带清理：跑完删除本次创建的行与磁盘文件（依据一次运行内记录的 id 列表，§3）。 */
const cleanups: Array<() => void> = [];

const main = (): void => {
  // `spec/07-验收标准.md` §2 前置：mock provider（未显式设置时默认 mock，避免 Windows 下 shell 前缀不通用）。
  if (!process.env.PROVIDER) process.env.PROVIDER = 'mock';
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failedIds = new Set<string>();

  try {
    for (const check of checks) {
      if (check.dependsOn?.some((d) => failedIds.has(d))) {
        skipped += 1;
        console.log(`[${check.id}] - skipped（依赖失败）`);
        continue;
      }
      let result: CheckResult;
      try {
        result = check.run();
      } catch (err) {
        result = { ok: false, expected: '无异常', actual: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) {
        passed += 1;
        console.log(`[${check.id}] ✓ ${result.actual}`);
      } else {
        failed += 1;
        failedIds.add(check.id);
        console.log(`[${check.id}] ✗ 期望 ${result.expected}，实际 ${result.actual}`);
      }
    }
  } finally {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        /* 清理失败不影响判定 */
      }
    }
  }

  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
};

main();
