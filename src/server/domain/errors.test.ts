import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../shared/types';
import { AppError, ERROR_MESSAGE, ERROR_STATUS, appError } from './errors';

/** 逐行对照 `docs/prd/spec/03-接口契约.md` §5 错误码总表：状态码是外部可观察契约。 */
const SPEC_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_PARAM: 400,
  INVALID_FILE_TYPE: 400,
  FILE_TOO_LARGE: 413,
  CODE_INVALID: 400,
  CODE_EXPIRED: 400,
  CODE_RATE_LIMITED: 429,
  CONSENT_REQUIRED: 403,
  ANCHOR_NOT_FOUND: 404,
  ANCHOR_NOT_CONFIRMED: 409,
  ANCHOR_LOW_QUALITY: 422,
  REALNAME_REQUIRED: 409,
  GENERATION_IN_PROGRESS: 409,
  QUOTA_EXCEEDED: 429,
  CONTENT_REJECTED: 422,
  PROVIDER_ERROR: 502,
  PROVIDER_TIMEOUT: 504,
  STORAGE_ERROR: 500,
  INTERNAL: 500,
};

describe('errors', () => {
  it('错误码清单与 spec/03 §5 一致，且每个码都有状态码与用户文案', () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(SPEC_STATUS).sort());
    for (const code of ERROR_CODES) {
      expect(ERROR_STATUS[code]).toBe(SPEC_STATUS[code]);
      expect(ERROR_MESSAGE[code]).toBeTruthy();
      expect(ERROR_MESSAGE[code]).not.toContain(code); // 用户文案里不该出现错误码本身
    }
  });

  it('AppError 带 code / message / status / details，且是 Error 的子类', () => {
    const err = new AppError('QUOTA_EXCEEDED', '今天的生成额度用完了，明天再来吧', 429, { day: '2026-09-17' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AppError');
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.status).toBe(429);
    expect(err.details).toEqual({ day: '2026-09-17' });
  });

  it('appError 按 code 取表里的状态码与文案', () => {
    const err = appError('PROVIDER_TIMEOUT');
    expect(err.status).toBe(504);
    expect(err.message).toBe(ERROR_MESSAGE.PROVIDER_TIMEOUT);
    expect(err.details).toBeUndefined();
  });
});
