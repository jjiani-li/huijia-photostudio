import { getDb } from '../connection';

/**
 * `users` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.1）。
 * 建号 / 首登 / 改名规则见 `docs/prd/modules/M08-账号历史与彻底删除.md` §3.1，归 `tickets/T12`、`tickets/T19` 补齐。
 */
export interface UserRecord {
  id: number;
  phone: string | null;
  email: string | null;
  nickname: string;
  realName: string | null;
  idHash: string | null;
  status: number;
  dailyImageQuota: number;
  createdAt: string;
  lastLoginAt: string | null;
  verifiedAt: string | null;
}

interface UserRow {
  id: number;
  phone: string | null;
  email: string | null;
  nickname: string;
  real_name: string | null;
  id_hash: string | null;
  status: number;
  daily_image_quota: number;
  created_at: string;
  last_login_at: string | null;
  verified_at: string | null;
}

const COLUMNS =
  'id, phone, email, nickname, real_name, id_hash, status, daily_image_quota, created_at, last_login_at, verified_at';

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  phone: row.phone,
  email: row.email,
  nickname: row.nickname,
  realName: row.real_name,
  idHash: row.id_hash,
  status: row.status,
  dailyImageQuota: row.daily_image_quota,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
  verifiedAt: row.verified_at,
});

export const findById = (id: number): UserRecord | null => {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as
    | UserRow
    | undefined;
  return row === undefined ? null : toUser(row);
};

export const findByPhone = (phone: string): UserRecord | null => {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM users WHERE phone = ?`).get(phone) as
    | UserRow
    | undefined;
  return row === undefined ? null : toUser(row);
};

export const findByEmail = (email: string): UserRecord | null => {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM users WHERE email = ?`).get(email) as
    | UserRow
    | undefined;
  return row === undefined ? null : toUser(row);
};

/** 按 `id_hash` 查（实名的唯一性校验，`docs/prd/modules/M08-账号历史与彻底删除.md` §2.2）。 */
export const findByIdHash = (idHash: string): UserRecord | null => {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM users WHERE id_hash = ?`).get(idHash) as
    | UserRow
    | undefined;
  return row === undefined ? null : toUser(row);
};

export interface InsertUserInput {
  /** 归一化后的手机号（11 位纯数字）或邮箱（小写）；二者恰一个非空（`users` 的 CHECK）。 */
  phone: string | null;
  email: string | null;
  nickname: string;
  createdAt: string;
}

/** 首登建号（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1）：`daily_image_quota` 走表默认值 20。 */
export const insertUser = (input: InsertUserInput): UserRecord => {
  const db = getDb();
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO users (phone, email, nickname, status, created_at)
         VALUES (@phone, @email, @nickname, 1, @createdAt)`,
      )
      .run(input);
    const row = db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(info.lastInsertRowid) as
      | UserRow
      | undefined;
    if (row === undefined) throw new Error('users 插入后读回失败');
    return toUser(row);
  })();
};

/** 首登后按 `id` 落最终 `nickname`（`用户` + id 后 4 位，`modules/M08` §2.1）。 */
export const updateNickname = (id: number, nickname: string): void => {
  getDb()
    .transaction(() => getDb().prepare('UPDATE users SET nickname = @nickname WHERE id = @id').run({ id, nickname }))();
};

export const touchLastLogin = (id: number, at: string): void => {
  getDb()
    .transaction(() =>
      getDb().prepare('UPDATE users SET last_login_at = @at WHERE id = @id').run({ id, at }),
    )();
};

export interface VerifyRealNameInput {
  realName: string;
  /** `sha256(归一化证件号)`；**只写哈希**（`docs/prd/spec/01-领域模型与数据库.md` §3.1）。 */
  idHash: string;
  verifiedAt: string;
}

/**
 * 实名落库（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.2）：一次 UPDATE 写齐
 * `real_name` / `id_hash` / `verified_at` 三列，`verified_at` 非空即已实名。
 * 唯一性由 `domain/authService.submitRealName()` 在写入之前按当前用户判定
 * （`id_hash` 的 UNIQUE 索引是库级兜底）。
 */
export const verifyRealName = (id: number, input: VerifyRealNameInput): void => {
  getDb()
    .transaction(() =>
      getDb()
        .prepare(
          `UPDATE users SET real_name = @realName, id_hash = @idHash, verified_at = @verifiedAt
           WHERE id = @id`,
        )
        .run({ ...input, id }),
    )();
};
