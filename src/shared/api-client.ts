import type { ApiError } from './types';

/**
 * 前端的**唯一请求入口**（`docs/prd/pages/P00-设计基准与路由.md` §2、§10）：
 * `credentials: 'same-origin'` + 统一错误 envelope → `ApiClientError`。
 * 页面 Client 组件一律经本模块取数，不自己拼 `fetch`（`spec/03-接口契约.md` §6）。
 */
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  /** JSON 请求体；与 `formData` 二选一。 */
  body?: unknown;
  /** `multipart/form-data`（`POST /api/photos`）；不设 `Content-Type`，交给浏览器带 boundary。 */
  formData?: FormData;
  signal?: AbortSignal;
}

const asError = (envelope: unknown, status: number): ApiClientError => {
  const error = (envelope as ApiError | null)?.error;
  return new ApiClientError(
    error?.code ?? 'INTERNAL',
    error?.message ?? '请求失败',
    status,
    error?.details,
  );
};

export const apiRequest = async <T>(path: string, options: ApiRequestOptions = {}): Promise<T> => {
  const { method = 'GET', body, formData, signal } = options;
  const init: RequestInit = { method, credentials: 'same-origin', signal };
  if (formData !== undefined) {
    init.body = formData;
  } else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  const res = await fetch(path, init);
  if (!res.ok) {
    const envelope = await res.json().catch(() => null);
    throw asError(envelope, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
};

/** 任意异常 → `ErrorNotice` 需要的 `{ code, message }`（非 `ApiClientError` 一律按 `INTERNAL`）。 */
export const toErrorNotice = (err: unknown): { code: string; message: string } =>
  err instanceof ApiClientError
    ? { code: err.code, message: err.message }
    : { code: 'INTERNAL', message: err instanceof Error ? err.message : '请求失败' };
