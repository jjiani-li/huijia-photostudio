import { getDb } from '../connection';
import type { Iso } from '../../../shared/types';

/**
 * `consents` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.11）。
 * 授权范围取值 `photo_usage` / `family_agreement`（`spec/01` §3.11）；
 * 幂等复用判定与吊销归 `tickets/T07`、`tickets/T13`。
 */
export interface ConsentRecord {
  id: number;
  userId: number;
  scope: string;
  anchorId: number | null;
  agreedAt: Iso;
  revokedAt: Iso | null;
}

interface ConsentRow {
  id: number;
  user_id: number;
  scope: string;
  anchor_id: number | null;
  agreed_at: string;
  revoked_at: string | null;
}

const COLUMNS = 'id, user_id, scope, anchor_id, agreed_at, revoked_at';

const toConsent = (row: ConsentRow): ConsentRecord => ({
  id: row.id,
  userId: row.user_id,
  scope: row.scope,
  anchorId: row.anchor_id,
  agreedAt: row.agreed_at,
  revokedAt: row.revoked_at,
});

/**
 * 幂等写：同 `userId` + `anchorId` + `scope` 未吊销则复用，不新增（`modules/M04-身份确认与授权.md` §5.1 ⑤）。
 * 这是「读判 → 写」，用 `BEGIN IMMEDIATE` 取写锁（`spec/04-技术基线与目录结构.md` §4.3）。
 */
export const ensureActive = (input: {
  userId: number;
  anchorId: number | null;
  scope: string;
  agreedAt: Iso;
}): ConsentRecord => {
  const db = getDb();
  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT ${COLUMNS} FROM consents
         WHERE user_id = @userId AND scope = @scope AND anchor_id IS @anchorId AND revoked_at IS NULL
         LIMIT 1`,
      )
      .get(input) as ConsentRow | undefined;
    if (existing !== undefined) return toConsent(existing);
    const info = db
      .prepare(
        `INSERT INTO consents (user_id, scope, anchor_id, agreed_at)
         VALUES (@userId, @scope, @anchorId, @agreedAt)`,
      )
      .run(input);
    const row = db.prepare(`SELECT ${COLUMNS} FROM consents WHERE id = ?`).get(info.lastInsertRowid) as
      | ConsentRow
      | undefined;
    if (row === undefined) throw new Error('consents 插入后读回失败');
    return toConsent(row);
  }).immediate();
};

export const hasActiveScope = (userId: number, scope: string): boolean =>
  getDb()
    .prepare('SELECT 1 FROM consents WHERE user_id = ? AND scope = ? AND revoked_at IS NULL LIMIT 1')
    .get(userId, scope) !== undefined;

export const listByUser = (userId: number): ConsentRecord[] =>
  (
    getDb().prepare(`SELECT ${COLUMNS} FROM consents WHERE user_id = ? ORDER BY agreed_at DESC`).all(
      userId,
    ) as ConsentRow[]
  ).map(toConsent);

/** 吊销不删行（授权留痕，`spec/01` §2.3）。 */
export const revokeByAnchor = (anchorId: number, revokedAt: Iso): void => {
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          'UPDATE consents SET revoked_at = @revokedAt WHERE anchor_id = @anchorId AND revoked_at IS NULL',
        )
        .run({ anchorId, revokedAt }),
    )();
};

/**
 * 吊销某用户某 `scope` 的全部有效行（`docs/prd/modules/M04-身份确认与授权.md` §5.5）：
 * 不删行、不改 `agreed_at`，只写 `revoked_at`；返回被吊销的行数。
 * 入口只有 `anchorService.revokeConsents`（无端点、无 UI）。
 */
export const revokeByScope = (userId: number, scope: string, revokedAt: Iso): number =>
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE consents SET revoked_at = @revokedAt
           WHERE user_id = @userId AND scope = @scope AND revoked_at IS NULL`,
        )
        .run({ userId, scope, revokedAt }).changes,
    )();
