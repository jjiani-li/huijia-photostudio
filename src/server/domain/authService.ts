import { randomInt, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db/connection';
import { audit } from '../security/audit';
import { appError } from './errors';
import { isoMinutesAgo, isoMinutesFromNow, nowIso } from './time';
import { normalizeIdentifier, type IdentifierChannel } from '../auth/identifier';
import { assertDevCodeAllowed, devLoginCode, exposeDevCode, getSmsSender } from '../auth/sms';
import { createSession, destroySession, hashToken, readSessionToken } from '../auth/session';
import { maskIdentifier, toApiUser } from '../auth/mask';
import { readQuota, type QuotaView } from '../security/quota';
import * as loginCodes from '../db/repositories/loginCodes';
import * as sessions from '../db/repositories/sessions';
import * as users from '../db/repositories/users';
import type { UserRecord } from '../db/repositories/users';
import type { User } from '../../shared/types';

/**
 * 验证码账号与会话的编排（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1）：
 * 发码（归一化 + 60 秒节流 + 10 分钟过期）、登录（三态校验 + 首登建号 + 会话签发）、登出（吊销 + 审计）。
 * 端点本体只做「zod 解析 → 调本模块 → 封装响应」（`spec/04-技术基线与目录结构.md` §3.1）。
 */

/** 验证码有效期 10 分钟 → `expiresInSec` 恒 600（`modules/M08` §5.1）。 */
const CODE_TTL_SECONDS = 600;
/** 同 `identifier` 的发码节流窗口。 */
const RATE_WINDOW_MS = 60 * 1000;
const CODE_RE = /^\d{6}$/;

/** 首登 `nickname` 规则：`用户` + `id % 10000` 左补零 4 位（`modules/M08` §2.1）。 */
export const nicknameForId = (id: number): string => `用户${String(id % 10000).padStart(4, '0')}`;

export interface RequestCodeResult {
  sent: true;
  expiresInSec: number;
  devCode?: string;
}

/**
 * 发码（`POST /api/auth/code`）：节流命中 → `429 CODE_RATE_LIMITED`；否则生成 6 位码、
 * 单事务写 `login_codes` + `audit_logs(auth.code_sent)`，再经发送器打出。
 * `devCode` **仅** `SMS_PROVIDER=console` 时返回（`SEC-07`）。
 */
export const requestLoginCode = (params: {
  identifier: string;
  channel?: IdentifierChannel;
}): RequestCodeResult => {
  const identifier = normalizeIdentifier(params.identifier, params.channel);
  const now = nowIso();
  const since = isoMinutesAgo(RATE_WINDOW_MS / 60_000);
  if (loginCodes.findRecentUnconsumed(identifier, since) !== null) throw appError('CODE_RATE_LIMITED');

  // `SMS_PROVIDER=real` 在 `getSmsSender()` 里抛 `INTERNAL`——先取发送器，避免留下无通道可发的码。
  const sender = getSmsSender();
  const code = randomInt(0, 1_000_000)
    .toString()
    .padStart(6, '0');
  const expiresAt = isoMinutesFromNow(CODE_TTL_SECONDS / 60);

  getDb().transaction(() => {
    loginCodes.insert({ identifier, code, purpose: 'login', expiresAt, createdAt: now });
    audit(
      {
        action: 'auth.code_sent',
        userId: null,
        meta: { identifier: maskIdentifier(identifier), channel: identifier.includes('@') ? 'email' : 'phone' },
      },
      now,
    );
  })();

  sender.send(identifier, code);
  const result: RequestCodeResult = { sent: true, expiresInSec: CODE_TTL_SECONDS };
  if (exposeDevCode()) result.devCode = code;
  assertDevCodeAllowed(result);
  return result;
};

/**
 * 码比对（`modules/M08` §2.1）：比较前校验长度均为 6；`console` 下 `DEV_LOGIN_CODE` 为万能码
 * （**仍需**存在未消费且未过期的记录——这一层由调用方在比对之前完成）。
 */
export const codeMatches = (expected: string, provided: string): boolean => {
  if (!CODE_RE.test(expected) || !CODE_RE.test(provided)) return false;
  const universal = devLoginCode();
  if (exposeDevCode() && CODE_RE.test(universal) && provided === universal) return true;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
};

export interface LoginResult {
  user: UserRecord;
  token: string;
}

/**
 * 登录（`POST /api/auth/login`，单事务）：校验顺序固定「存在/已消费 → 过期 → 码值」；
 * 通过后消费码、按 `phone` / `email` 查/建用户（首登落 `nickname` 规则）、更新 `last_login_at`、
 * 签发会话、写 `audit_logs(auth.login)`。返回明文 token，由 route 写 cookie。
 */
export const loginWithCode = (params: { identifier: string; code: string }): LoginResult => {
  const identifier = normalizeIdentifier(params.identifier);
  const now = nowIso();

  const record = loginCodes.findLatestLogin(identifier);
  if (record === null || record.consumedAt !== null) throw appError('CODE_INVALID');
  if (record.expiresAt < now) throw appError('CODE_EXPIRED');
  if (!codeMatches(record.code, params.code)) throw appError('CODE_INVALID');

  const isEmail = identifier.includes('@');
  return getDb().transaction(() => {
    loginCodes.consume(record.id, now);

    let user = isEmail ? users.findByEmail(identifier) : users.findByPhone(identifier);
    if (user === null) {
      const created = users.insertUser({
        phone: isEmail ? null : identifier,
        email: isEmail ? identifier : null,
        nickname: '用户',
        createdAt: now,
      });
      users.updateNickname(created.id, nicknameForId(created.id));
      const reread = users.findById(created.id);
      if (reread === null) throw appError('INTERNAL', { reason: '首登建号后读回失败' });
      user = reread;
    }
    users.touchLastLogin(user.id, now);
    const { token } = createSession(user.id);
    audit({ action: 'auth.login', userId: user.id, target: `user:${user.id}` }, now);
    return { user, token };
  })();
};

/**
 * 登出（`POST /api/auth/logout`）：按 `token_hash` 吊销未吊销行（幂等）、写 `audit_logs(auth.logout)`。
 * 无会话 / 会话已失效时不写审计（拿不到 `user_id`），仍返回成功由 route 清 cookie。
 */
export const logout = (req?: Request): void => {
  const token = readSessionToken(req);
  if (token === null) return;
  const now = nowIso();
  const session = sessions.findActiveByTokenHash(hashToken(token), now);
  destroySession(token);
  if (session !== null) {
    audit({ action: 'auth.logout', userId: session.userId, target: `user:${session.userId}` }, now);
  }
};

/**
 * `GET /api/me` 的响应体（`docs/prd/spec/03-接口契约.md` §3.1、§4）：`user` 经 `mask.ts` 脱敏、
 * `quota` 取 `readQuota()`（`tickets/T09` 下沉）。组装放这里，路由只做「鉴权 → 调 service → 封装」。
 */
export const readMe = (userId: number): { user: User; quota: QuotaView } => {
  const user = users.findById(userId);
  if (user === null) throw appError('UNAUTHENTICATED');
  return { user: toApiUser(user), quota: readQuota(userId) };
};
