import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * SQLite 连接单例（`docs/prd/spec/04-技术基线与目录结构.md` §4.3）。
 * 连接级 PRAGMA 一律在事务之外设置——SQLite 禁止在事务内切换 `journal_mode`，
 * 因此它们绝不能写进 `migrations/*.sql`（`docs/prd/spec/01-领域模型与数据库.md` §5.1）。
 */
let instance: Database.Database | null = null;

/** 库文件路径，由 `DATABASE_PATH` 决定，默认 `./data/app.db`（`docs/prd/spec/08-本地开发指南.md` §4）。 */
export const dbPath = (): string => process.env.DATABASE_PATH ?? './data/app.db';

/** 内存/文件两用：传入路径时返回新连接（测试用），不注册为单例。 */
export const openDb = (file: string): Database.Database => {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF'); // 软删除语义靠应用层，不启用外键级联（spec/01 §2.3）
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
};

/** `pnpm dev` 与 `pnpm worker` 两进程共享同一个库文件，故必须走单例。 */
export const getDb = (): Database.Database => {
  if (instance === null) instance = openDb(dbPath());
  return instance;
};

/** 关闭单例；测试与 `db:reset` 在删除库文件前调用。 */
export const closeDb = (): void => {
  instance?.close();
  instance = null;
};
