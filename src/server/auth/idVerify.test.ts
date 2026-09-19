import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '../domain/errors';
import {
  getIdVerifyProvider,
  idCheckChar,
  idHashOf,
  isValidIdNumber,
  isValidRealName,
  LocalIdVerifyProvider,
  normalizeIdNumber,
  resetIdVerifyProvider,
} from './idVerify';

/**
 * 实名校验通道（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.2、`docs/prd/spec/06-合规与风控.md` §5.2）：
 * 姓名与证件号的格式校验（长度与校验位）、`id_hash = sha256(归一化后的证件号)` 且不落明文、
 * `ID_VERIFY_PROVIDER=real` 是生产留空位（抛 `INTERNAL`）。唯一性要当前用户身份，属 `domain/authService`。
 * 本文件不碰数据库（`verify()` 是纯函数），端点侧另有 `app/api/me/realname/routes.test.ts`。
 */

/** 三个格式合法、校验位正确的样本（`11010519491231002X` 是 GB 11643 的公开样例）。 */
const VALID_IDS = ['11010519491231002X', '310101199001011234', '440305198506200074'];

afterAll(() => {
  resetIdVerifyProvider();
  delete process.env.ID_VERIFY_PROVIDER;
});

const codeAndFields = (fn: () => unknown): { code: string; fields: Record<string, string[]> } => {
  try {
    fn();
    return { code: 'NO_THROW', fields: {} };
  } catch (err) {
    if (err instanceof AppError) {
      return { code: err.code, fields: (err.details as { fields?: Record<string, string[]> } | undefined)?.fields ?? {} };
    }
    return { code: `NON_APP_ERROR:${String(err)}`, fields: {} };
  }
};

/** 姓名：2–20 个中日韩文字 / 拉丁字母（可含间隔号与半角空格），数字、符号与控制字符不算。 */
describe('格式校验（spec/06 §5.2 的「长度与校验位」）', () => {
  it('姓名：2–20 个中日韩文字 / 拉丁字母（可含间隔号与空格），数字与符号不算', () => {
    expect(isValidRealName('张三')).toBe(true);
    expect(isValidRealName(' 欧阳·娜娜 ')).toBe(true);
    expect(isValidRealName('Li Hua')).toBe(true);
    expect(isValidRealName('张')).toBe(false);
    expect(isValidRealName('')).toBe(false);
    expect(isValidRealName('张3')).toBe(false);
    expect(isValidRealName('张三@')).toBe(false);
    expect(isValidRealName('张\t三')).toBe(false);
    expect(isValidRealName('张\n三')).toBe(false);
    expect(isValidRealName('张'.repeat(21))).toBe(false);
  });

  it('证件号：17 位数字 + 数字或 X 的校验位；校验位错、长度不符一律拒', () => {
    for (const id of VALID_IDS) expect(isValidIdNumber(id)).toBe(true);
    expect(isValidIdNumber('11010519491231002x')).toBe(true); // 末位 x 归一化为 X
    expect(isValidIdNumber('110105194912310021')).toBe(false); // 校验位错
    expect(isValidIdNumber('110105194912310024')).toBe(false); // 校验位错
    expect(isValidIdNumber('11010519491231002')).toBe(false); // 17 位
    expect(isValidIdNumber('11010519491231002XY')).toBe(false); // 19 位
    expect(isValidIdNumber('')).toBe(false);
  });

  it('idCheckChar 与归一化：同一个证件号恒得同一个哈希', () => {
    expect(idCheckChar('11010519491231002')).toBe('X');
    expect(normalizeIdNumber(' 11010519491231002x ')).toBe('11010519491231002X');
    expect(idHashOf('11010519491231002X')).toBe(idHashOf('11010519491231002x'));
  });
});

describe('id_hash（RN-02）', () => {
  it('是 64 位十六进制，且不等于证件号明文', () => {
    const hash = idHashOf(VALID_IDS[0] as string);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(VALID_IDS[0] as string);
    expect(hash).toBe(idHashOf(VALID_IDS[0] as string));
  });
});

describe('LocalIdVerifyProvider', () => {
  it('格式合法 → 归一化姓名 + id_hash + verifiedAt（ISO）', () => {
    const result = new LocalIdVerifyProvider().verify({ realName: ' 张三 ', idNumber: VALID_IDS[1] as string });
    expect(result.realName).toBe('张三');
    expect(result.idHash).toBe(idHashOf(VALID_IDS[1] as string));
    expect(result.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('格式非法 → INVALID_PARAM 且 details.fields 点名 realName / idNumber', () => {
    const provider = new LocalIdVerifyProvider();
    expect(codeAndFields(() => provider.verify({ realName: '张三', idNumber: '123' })).fields).toEqual({
      idNumber: ['证件号格式不对'],
    });
    expect(codeAndFields(() => provider.verify({ realName: '', idNumber: VALID_IDS[0] as string })).fields).toMatchObject({
      realName: [expect.any(String)],
    });
    const both = codeAndFields(() => provider.verify({ realName: '张3', idNumber: '' }));
    expect(both.code).toBe('INVALID_PARAM');
    expect(Object.keys(both.fields).sort()).toEqual(['idNumber', 'realName']);
  });

  it('唯一性不在这里判（需要当前用户身份）：同证件号两次 verify 都出结果', () => {
    const provider = new LocalIdVerifyProvider();
    const first = provider.verify({ realName: '张三', idNumber: VALID_IDS[2] as string });
    const second = provider.verify({ realName: '张三', idNumber: VALID_IDS[2] as string });
    expect(second.idHash).toBe(first.idHash);
  });
});

describe('getIdVerifyProvider（spec/08 §4 的开关）', () => {
  it('缺省 / local → 本地实现', () => {
    delete process.env.ID_VERIFY_PROVIDER;
    resetIdVerifyProvider();
    expect(getIdVerifyProvider()).toBeInstanceOf(LocalIdVerifyProvider);
    process.env.ID_VERIFY_PROVIDER = 'local';
    resetIdVerifyProvider();
    expect(getIdVerifyProvider()).toBeInstanceOf(LocalIdVerifyProvider);
  });

  it('real 是生产留空位 → INTERNAL', () => {
    process.env.ID_VERIFY_PROVIDER = 'real';
    resetIdVerifyProvider();
    expect(codeAndFields(() => getIdVerifyProvider()).code).toBe('INTERNAL');
  });
});
