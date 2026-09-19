import { getDb } from '../connection';

/**
 * `sessions` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.3）。
 * cookie 下发 / 校验与登出流程归 `tickets/T12`；服务端只存 `sha256(token)`，明文不落库。
 * 写函数自带 `db.transaction`，可在 `domain/*Service` 的事务内安全嵌套（better-sqlite3 走 SAVEPOINT）。
 */
export interface SessionRecord {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
}

interface SessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}

const COLUMNS = 'id, user_id, token_hash, expires_at, created_at, revoked_at';

const toSession = (row: SessionRow): SessionRecord => ({
  id: row.id,
  userId: row.user_id,
  tokenHash: row.token_hash,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
});

export interface InsertSessionInput {
  userId: number;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export const insert = (input: InsertSessionInput): SessionRecord => {
  const db = getDb();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
         VALUES (@userId, @tokenHash, @expiresAt, @createdAt)`,
      )
      .run(input);
    const row = db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`).get(info.lastInsertRowid) as
      | SessionRow
      | undefined;
    if (row === undefined) throw new Error('sessions 插入后读回失败');
    return toSession(row);
  })();
};

export const findActiveByTokenHash = (tokenHash: string): SessionRecord | null => {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM sessions WHERE token_hash = ? AND revoked_at IS NULL`)
    .get(tokenHash) as SessionRow | undefined;
  return row === undefined ? null : toSession(row);
};

export const revoke = (id: number, revokedAt: string): void => {
  getDb()
    .transaction(() =>
      getDb()
        .prepare('UPDATE sessions SET revoked_at = @revokedAt WHERE id = @id AND revoked_at IS NULL')
        .run({ id, revokedAt }),
    )();
};
