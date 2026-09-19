import { appError } from '../domain/errors';

/**
 * 标识归一化（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1）：归一化结果即
 * `login_codes.identifier` 与 `users.phone` / `users.email` 的**唯一写入值**——手机号恒 11 位纯数字、
 * 邮箱恒小写。失败 → `400 INVALID_PARAM`。
 */
export type IdentifierChannel = 'phone' | 'email';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^1[3-9]\d{9}$/;

const invalid = (raw: string): never => {
  throw appError('INVALID_PARAM', { fields: { identifier: [`无法识别的手机号或邮箱：${raw}`] } });
};

/** 含 `@` 或显式 `channel='email'` 走邮箱（转小写）；否则走手机号（去分隔符、剥离 `+86` / 前导 `86`）。 */
export const normalizeIdentifier = (raw: string, channel?: IdentifierChannel): string => {
  const trimmed = raw.trim();
  const isEmail = channel === 'email' || trimmed.includes('@');
  if (isEmail) {
    const email = trimmed.toLowerCase();
    if (!EMAIL_RE.test(email)) return invalid(raw);
    return email;
  }
  const digits = trimmed.replace(/[\s\-()]/g, '').replace(/^\+?86/, '');
  if (!PHONE_RE.test(digits)) return invalid(raw);
  return digits;
};
