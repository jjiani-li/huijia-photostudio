import type { User } from '../../shared/types';

/**
 * 手机号 / 邮箱脱敏（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1、§3.1）。
 * `GET /api/me` 的 `user.phone` / `user.email` 必须经此二函数，`API-05` 据此断言响应含 `*`；
 * `/api/history` 的响应体不得出现明文（同 §5.1）。
 */

/** `'13800138000'` → `'138****8000'`；长度不足 7 时整串替换为等长 `*`。`null → null`。 */
export const maskPhone = (phone: string | null): string | null => {
  if (phone === null) return null;
  if (phone.length < 7) return '*'.repeat(phone.length);
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
};

/** `'abcd@x.com'` → `'a***@x.com'`；`local` 长度 1 → `'***@x.com'`。`null → null`。 */
export const maskEmail = (email: string | null): string | null => {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return `***`;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.length > 1 ? local[0] : '';
  return `${head}***${domain}`;
};

/** 含 `@` 走 `maskEmail`，否则走 `maskPhone`（`modules/M08` §2.1）。 */
export const maskIdentifier = (identifier: string | null): string | null =>
  identifier === null ? null : identifier.includes('@') ? maskEmail(identifier) : maskPhone(identifier);

/** `users` 行 → API 的 `User`（`spec/03-接口契约.md` §4）；`phone` / `email` 一律脱敏。 */
export const toApiUser = (user: {
  id: number;
  phone: string | null;
  email: string | null;
  nickname: string;
  status: number;
  createdAt: string;
}): User => ({
  id: user.id,
  phone: maskPhone(user.phone),
  email: maskEmail(user.email),
  nickname: user.nickname,
  status: user.status,
  createdAt: user.createdAt,
});
