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
