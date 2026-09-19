import { createHash } from 'node:crypto';
import { appError } from '../domain/errors';
import { nowIso } from '../domain/time';
import { findByIdHash } from '../db/repositories/users';
import type { Iso } from '../../shared/types';

/**
 * 实名校验通道抽象（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.2、`docs/prd/spec/04-技术基线与目录结构.md` §1）：
 * 与 Storage / SMS / Ark 三个 Provider 同一惯例。本期只有 `LocalIdVerifyProvider`：
 * **格式校验（姓名 + 证件号长度与校验位）+ 唯一性校验（`id_hash` 唯一）**；`ID_VERIFY_PROVIDER=real` 是生产留空位。
 *
 * 「本地实名 ≠ 真实身份核验」的逐项对照见 `docs/prd/spec/06-合规与风控.md` §5.2：本地不接触任何权威数据源，
 * 不做联网核验、人脸比对、一号多账号拦截、频次风控。
 */
export interface IdVerifyRequest {
  realName: string;
  idNumber: string;
}

export interface IdVerifyResult {
  realName: string;
  /** `sha256(证件号)` 十六进制小写；**只存哈希、不存明文**（`spec/01-领域模型与数据库.md` §3.1）。 */
  idHash: string;
  verifiedAt: Iso;
}

export interface IdVerifyProvider {
  verify(req: IdVerifyRequest): IdVerifyResult;
}

/**
 * 姓名的字符域：中日韩文字 / 拉丁字母 / 间隔号 / 空格（`spec/06-合规与风控.md` §5.2 的「非空 + 长度与字符格式校验」）。
 * 长度取 2–20 —— 契约只写了「长度」，具体区间与本文件其余常数一样属实现细节（见 `tickets/T19` 的 `## Comments`）。
 */
const REAL_NAME_CHAR_RE = /^[\u3400-\u9fff\u3040-\u30ffA-Za-z·\s]+$/;
const REAL_NAME_MIN = 2;
const REAL_NAME_MAX = 20;

/** 证件号：18 位（17 位数字 + 1 位数字或 `X`），末位为 ISO 7064 MOD 11-2 校验位。 */
const ID_NUMBER_RE = /^\d{17}[\dX]$/;
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK_CHARS = '10X98765432';

/** 归一化：去空白、末位 `x` 统一大写——同一个证件号必须恒得同一个 `id_hash`。 */
export const normalizeIdNumber = (raw: string): string => raw.trim().toUpperCase();

/** 归一化：去首尾空白（中间的空格保留，少数民族姓名的间隔号 / 空格是有效字符）。 */
export const normalizeRealName = (raw: string): string => raw.trim();

/** ISO 7064 MOD 11-2 校验位（前 17 位 → 第 18 位）。 */
export const idCheckChar = (first17: string): string => {
  const sum = ID_WEIGHTS.reduce((acc, weight, i) => acc + Number(first17[i]) * weight, 0);
  return ID_CHECK_CHARS.charAt(sum % 11);
};

export const isValidRealName = (raw: string): boolean => {
  const name = normalizeRealName(raw);
  return name.length >= REAL_NAME_MIN && name.length <= REAL_NAME_MAX && REAL_NAME_CHAR_RE.test(name);
};

export const isValidIdNumber = (raw: string): boolean => {
  const id = normalizeIdNumber(raw);
  if (!ID_NUMBER_RE.test(id)) return false;
  return idCheckChar(id.slice(0, 17)) === id[17];
};

/** `id_hash = sha256(归一化后的证件号)`（`spec/01` §3.1、`modules/M08` §2.2）。 */
export const idHashOf = (raw: string): string =>
  createHash('sha256').update(normalizeIdNumber(raw), 'utf8').digest('hex');

/** 本地实名（默认）：格式校验 + 唯一性校验。 */
export class LocalIdVerifyProvider implements IdVerifyProvider {
  verify(req: IdVerifyRequest): IdVerifyResult {
    const realName = normalizeRealName(req.realName);
    const fields: Record<string, string[]> = {};
    if (!isValidRealName(realName)) fields.realName = [`姓名需要 ${REAL_NAME_MIN}–${REAL_NAME_MAX} 个字符，且不含数字或符号`];
    if (!isValidIdNumber(req.idNumber)) fields.idNumber = ['证件号格式不对'];
    if (Object.keys(fields).length > 0) throw appError('INVALID_PARAM', { fields });

    const idHash = idHashOf(req.idNumber);
    // 唯一性（`modules/M08` §2.2）：`id_hash` 已有行即拒绝——含「同一个用户重复提交」，
    // 实名只写一次、不改写（`users.id_hash` 的 UNIQUE 索引是库级兜底）。
    if (findByIdHash(idHash) !== null) throw appError('INVALID_PARAM', { fields: { idNumber: ['这个证件号已经实名过了'] } });

    return { realName, idHash, verifiedAt: nowIso() };
  }
}

/** `ID_VERIFY_PROVIDER` 的当前取值（缺省 `local`）。 */
const idVerifyProviderName = (): string => process.env.ID_VERIFY_PROVIDER ?? 'local';

let instance: IdVerifyProvider | null = null;

/** `ID_VERIFY_PROVIDER`（默认 `local`）→ 校验器单例；`real` 是生产留空位，取该值抛 `INTERNAL`。 */
export const getIdVerifyProvider = (): IdVerifyProvider => {
  if (idVerifyProviderName() === 'real') {
    throw appError('INTERNAL', { reason: 'ID_VERIFY_PROVIDER=real 本期无真实核验通道' });
  }
  if (instance === null) instance = new LocalIdVerifyProvider();
  return instance;
};

/** 测试用：清空单例。 */
export const resetIdVerifyProvider = (): void => {
  instance = null;
};
