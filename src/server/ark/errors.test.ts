import { describe, expect, it } from 'vitest';
import { ArkUpstreamError, mapArkError, type ArkErrorShape } from './errors';
import { readFailureFixture } from './fixtures';

/**
 * `mapArkError` 的逐条映射（`docs/prd/modules/M06-生成编排.md` §5.8）。
 * `ERR-03`：`fixtures/ark/invalid-size.json` → `INTERNAL` 且不重试。
 */
const mapShape = (shape: ArkErrorShape) => mapArkError(new ArkUpstreamError(shape));

describe('ERR-03 · 三个冻结的失败样本', () => {
  it('invalid-size.json（InvalidParameter，size 低于下限）→ INTERNAL 且不重试', () => {
    const mapping = mapArkError(new ArkUpstreamError(readFailureFixture('invalid-size')));
    expect(mapping.code).toBe('INTERNAL');
    expect(mapping.retryable).toBe(false);
  });

  it('model-not-open.json（ModelNotOpen）→ PROVIDER_ERROR 不重试', () => {
    const mapping = mapArkError(new ArkUpstreamError(readFailureFixture('model-not-open')));
    expect(mapping.code).toBe('PROVIDER_ERROR');
    expect(mapping.retryable).toBe(false);
  });

  it('timeout.json → PROVIDER_TIMEOUT 可重试', () => {
    const mapping = mapArkError(new ArkUpstreamError(readFailureFixture('timeout')));
    expect(mapping.code).toBe('PROVIDER_TIMEOUT');
    expect(mapping.retryable).toBe(true);
  });
});

describe('mapArkError · 其余分支', () => {
  it('429 / 5xx → PROVIDER_ERROR 可重试', () => {
    expect(mapShape({ kind: 'http', httpStatus: 429 }).code).toBe('PROVIDER_ERROR');
    expect(mapShape({ kind: 'http', httpStatus: 429 }).retryable).toBe(true);
    expect(mapShape({ kind: 'http', httpStatus: 503 }).retryable).toBe(true);
  });

  it('其它 4xx → PROVIDER_ERROR 不重试；401/403 → INTERNAL 不重试', () => {
    expect(mapShape({ kind: 'http', httpStatus: 404 }).code).toBe('PROVIDER_ERROR');
    expect(mapShape({ kind: 'http', httpStatus: 404 }).retryable).toBe(false);
    expect(mapShape({ kind: 'http', httpStatus: 401 }).code).toBe('INTERNAL');
  });

  it('InvalidEndpointOrModel.* → PROVIDER_ERROR 不重试', () => {
    expect(mapShape({ kind: 'http', httpStatus: 400, errorCode: 'InvalidEndpointOrModel.NotFound' }).code).toBe(
      'PROVIDER_ERROR',
    );
  });

  it('网络 / 写盘 / 空 data → 可重试', () => {
    expect(mapShape({ kind: 'network' }).code).toBe('PROVIDER_TIMEOUT');
    expect(mapShape({ kind: 'storage' }).code).toBe('STORAGE_ERROR');
    expect(mapShape({ kind: 'storage' }).retryable).toBe(true);
    expect(mapShape({ kind: 'http', errorCode: 'EmptyData' }).retryable).toBe(true);
  });

  it('未知错误 → INTERNAL 不重试', () => {
    const mapping = mapArkError(new Error('boom'));
    expect(mapping.code).toBe('INTERNAL');
    expect(mapping.retryable).toBe(false);
  });
});
