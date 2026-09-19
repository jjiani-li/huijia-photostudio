import type { ErrorCode } from '../../shared/types';

/**
 * 上游错误 → 本项目错误码的唯一映射入口（`docs/prd/modules/M06-生成编排.md` §5.8）。
 * 判定顺序：先 `error.code`，再看 HTTP 状态，最后落 `INTERNAL`。
 */
export type ArkFailureKind = 'http' | 'timeout' | 'network' | 'storage';

export interface ArkErrorShape {
  kind: ArkFailureKind;
  /** 上游 `error.code`（如 `ModelNotOpen` / `InvalidParameter`）。 */
  errorCode?: string;
  httpStatus?: number;
  message?: string;
}

/** `real.ts` 与 `mock.ts` 抛出的统一形态；`mapArkError` 只认它。 */
export class ArkUpstreamError extends Error {
  constructor(public readonly shape: ArkErrorShape) {
    super(shape.message ?? shape.errorCode ?? shape.kind);
    this.name = 'ArkUpstreamError';
  }
}

export interface ArkErrorMapping {
  code: ErrorCode;
  retryable: boolean;
  raw: string;
}

export const mapArkError = (err: unknown): ArkErrorMapping => {
  const shape: ArkErrorShape =
    err instanceof ArkUpstreamError
      ? err.shape
      : { kind: 'http', message: err instanceof Error ? err.message : String(err) };
  const raw = shape.message ?? shape.errorCode ?? shape.kind;
  const upstream = shape.errorCode;

  if (upstream === 'ModelNotOpen') return { code: 'PROVIDER_ERROR', retryable: false, raw };
  if (upstream === 'EmptyData') return { code: 'PROVIDER_ERROR', retryable: true, raw };
  if (upstream?.startsWith('InvalidParameter')) return { code: 'INTERNAL', retryable: false, raw };
  if (upstream?.startsWith('InvalidEndpointOrModel')) {
    return { code: 'PROVIDER_ERROR', retryable: false, raw };
  }
  if (upstream === 'InternalServiceError') return { code: 'PROVIDER_ERROR', retryable: true, raw };

  if (shape.kind === 'timeout' || shape.kind === 'network') {
    return { code: 'PROVIDER_TIMEOUT', retryable: true, raw };
  }
  if (shape.kind === 'storage') return { code: 'STORAGE_ERROR', retryable: true, raw };

  const status = shape.httpStatus;
  if (status === 429 || (status !== undefined && status >= 500)) {
    return { code: 'PROVIDER_ERROR', retryable: true, raw };
  }
  if (status === 401 || status === 403) return { code: 'INTERNAL', retryable: false, raw };
  if (status !== undefined && status >= 400) return { code: 'PROVIDER_ERROR', retryable: false, raw };

  return { code: 'INTERNAL', retryable: false, raw };
};
