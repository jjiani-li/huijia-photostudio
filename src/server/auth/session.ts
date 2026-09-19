import { createHash, randomBytes } from 'node:crypto';
import { appError } from '../domain/errors';
import { nowIso } from '../domain/time';
import { findById } from '../db/repositories/users';
import { findActiveByTokenHash, insert as insertSession, revokeByTokenHash } from '../db/repositories/sessions';
import type { SessionUser } from '../../shared/types';

/**
 * 会话（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1）：读 cookie → `sessions` 活跃行 → `users`。
 *
 * `tickets/T12` 在**同一路径**替换了 `tickets/T02` 的鉴权桩：桩里「不查 cookie、直接返回 `DEV_USER`」
 * 的行为已不存在（桩随之消失）。每个受保护端点在 handler 第一行调 `requireUser(req)`；`req` 为
 * route handler 收到的 `NextRequest`（读它的 `cookie` 头），使其在单测里也能直接构造带 cookie 的请求。
 */

export const SID_COOKIE = 'sid';

/** 会话有效期 30 天（`spec/03-接口契约.md` §1.2 的 cookie `Max-Age=2592000` 与之逐字一致）。 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** cookie 值的格式闸门：缺失或不匹配即**不查库**直接 `null`（`modules/M08` §2.1）。 */
const SID_RE = /^[A-Za-z0-9_-]{43}$/;

/** 服务端只存 `sha256(token)` 十六进制小写；明文只在响应里出现一次（`modules/M08` §2.1）。 */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** 从请求的 `cookie` 头取 `sid`（NextRequest 与测试里的 `Request` 都带 `headers`）。 */
const readSid = (req?: Request): string | null => {
  const header = req?.headers?.get('cookie');
  if (header === undefined || header === null) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SID_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
};

/**
 * cookie 缺失或格式非法 → `null`（**不查库**）；否则 `sessions` 活跃行（未吊销且未过期）→ `users.status=1`。
 */
export const getSessionUser = (req?: Request): SessionUser | null => {
  const token = readSid(req);
  if (token === null || !SID_RE.test(token)) return null;
  const session = findActiveByTokenHash(hashToken(token), nowIso());
  if (session === null) return null;
  const user = findById(session.userId);
  if (user === null || user.status !== 1) return null;
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    nickname: user.nickname,
    status: user.status,
  };
};

/** 受保护端点第一行调用；未登录 / 会话无效 → `401 UNAUTHENTICATED`（`spec/03` §1.2、`API-03`）。 */
export const requireUser = (req?: Request): SessionUser => {
  const user = getSessionUser(req);
  if (user === null) throw appError('UNAUTHENTICATED');
  return user;
};

/** 登录签发：`randomBytes(32).toString('base64url')`（43 字符）→ sha256 落库，返回明文与新会话 token。 */
export const createSession = (userId: number): { token: string; expiresAt: string } => {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  insertSession({ userId, tokenHash: hashToken(token), expiresAt, createdAt: nowIso() });
  return { token, expiresAt };
};

/** 登出：按 `token_hash` 吊销（幂等）；`token` 为 `null` 时什么都不做。 */
export const destroySession = (token: string | null): void => {
  if (token === null) return;
  revokeByTokenHash(hashToken(token), nowIso());
};

/** 登出清 cookie 用：从请求里取明文 token（与 `getSessionUser` 同一读取口径）。 */
export const readSessionToken = (req?: Request): string | null => readSid(req);
