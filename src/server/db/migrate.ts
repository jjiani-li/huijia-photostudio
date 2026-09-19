import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './connection';
import { isMain } from './cli';
import { nowIso } from '../domain/time';

/**
 * 迁移执行器（`docs/prd/spec/01-领域模型与数据库.md` §5.1）：
 * 建 `schema_migrations` 记账，按文件名顺序执行未应用迁移，**每个文件单事务**；
 * 只前进不后退，重置即删库重跑（重置入口见 `src/server/db/reset.ts`）。
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export const runMigrations = (): MigrationResult => {
  const db = getDb();
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const done = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map(
      (row) => row.version,
    ),
  );
  const applied: string[] = [];
  const skipped: string[] = [];
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        file,
        nowIso(),
      );
    })();
    applied.push(file);
  }
  return { applied, skipped };
};

if (isMain(import.meta.url)) {
  const result = runMigrations();
  console.log(
    JSON.stringify({
      level: 'info',
      scope: 'migrate',
      msg: 'migrations applied',
      applied: result.applied,
      skipped: result.skipped,
      at: nowIso(),
    }),
  );
}
