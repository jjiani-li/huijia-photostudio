import fs from 'node:fs';
import { closeDb, dbPath } from './connection';
import { isMain } from './cli';
import { runMigrations } from './migrate';
import { runSeed, type SeedResult } from './seed';
import { nowIso } from '../domain/time';

/**
 * `pnpm db:reset`（`docs/prd/spec/08-本地开发指南.md` §6）：
 * 删除库文件与 `STORAGE_DIR`（破坏性，仅本地），再重建并 seed。
 */
export const resetDatabase = (): { removed: string[] } & SeedResult => {
  closeDb();
  const removed: string[] = [];
  const dbFile = dbPath();
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbFile}${suffix}`;
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      removed.push(target);
    }
  }
  const storageDir = process.env.STORAGE_DIR ?? './storage';
  if (fs.existsSync(storageDir)) {
    fs.rmSync(storageDir, { recursive: true, force: true });
    removed.push(storageDir);
  }
  runMigrations();
  return { removed, ...runSeed() };
};

if (isMain(import.meta.url)) {
  const result = resetDatabase();
  console.log(
    JSON.stringify({
      level: 'info',
      scope: 'db:reset',
      msg: 'database reset and reseeded',
      ...result,
      at: nowIso(),
    }),
  );
}
