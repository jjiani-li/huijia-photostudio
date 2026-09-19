import { getDb } from '../connection';

/**
 * `login_codes` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.2）。
 * 发码节流（同一 `identifier` 60 秒内 1 条未消费记录）是应用层判断，归 `tickets/T12`。
 */
export interface LoginCodeRecord {
  id: number;
  identifier: string;
  code: string;
  purpose: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

interface LoginCodeRow {
  id: number;
  identifier: string;
  code: string;
  purpose: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

const COLUMNS = 'id, identifier, code, purpose, expires_at, consumed_at, created_at';

const toLoginCode = (row: LoginCodeRow): LoginCodeRecord => ({
  id: row.id,
  identifier: row.identifier,
  code: row.code,
  purpose: row.purpose,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at,
  createdAt: row.created_at,
});

export interface InsertLoginCodeInput {
  identifier: string;
  code: string;
  purpose: string;
  expiresAt: string;
  createdAt: string;
}

export const insert = (input: InsertLoginCodeInput): LoginCodeRecord => {
  const db = getDb();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO login_codes (identifier, code, purpose, expires_at, created_at)
         VALUES (@identifier, @code, @purpose, @expiresAt, @createdAt)`,
      )
      .run(input);
    const row = db.prepare(`SELECT ${COLUMNS} FROM login_codes WHERE id = ?`).get(info.lastInsertRowid) as
      | LoginCodeRow
      | undefined;
    if (row === undefined) throw new Error('login_codes 插入后读回失败');
    return toLoginCode(row);
  })();
};

export const findLatestByIdentifier = (identifier: string): LoginCodeRecord | null => {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM login_codes WHERE identifier = ? ORDER BY created_at DESC LIMIT 1`)
    .get(identifier) as LoginCodeRow | undefined;
  return row === undefined ? null : toLoginCode(row);
};

export const consume = (id: number, consumedAt: string): void => {
  getDb()
    .transaction(() =>
      getDb()
        .prepare('UPDATE login_codes SET consumed_at = @consumedAt WHERE id = @id AND consumed_at IS NULL')
        .run({ id, consumedAt }),
    )();
};
