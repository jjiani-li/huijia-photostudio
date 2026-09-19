import type { ApiError } from './types';
import { errorMessageOf } from './error-message';

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

/** `ErrorNotice` 消费的 `{ code, message }`（`docs/prd/pages/P00-设计基准与路由.md` §8）。 */
export interface ApiNotice {
  code: string;
  message: string;
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

/**
 * 任意异常 → `ErrorNotice` 需要的 `{ code, message }`：`ApiClientError` 原样（**服务端 `error.message`
 * 是用户可见文案的唯一来源**，`docs/prd/spec/03-接口契约.md` §1.3），其余（网络层 `fetch` 抛错、
 * 服务端 `message` 为空的边界）取 `src/shared/error-message.ts` 的文案，不把 `Failed to fetch`
 * 这类技术串呈现给用户（`docs/prd/pages/P01-上传与身份确认.md` §5、`pages/P00-设计基准与路由.md` §8）。
 */
export const toErrorNotice = (err: unknown): ApiNotice => {
  if (err instanceof ApiClientError) {
    return { code: err.code, message: err.message.trim() === '' ? errorMessageOf(err.code) : err.message };
  }
  return { code: 'INTERNAL', message: errorMessageOf('INTERNAL') };
};

/** `INVALID_PARAM` 的 `details.fields` 键名（只用于高亮对应控件，`docs/prd/spec/03-接口契约.md` §1.3）。 */
export const getFieldNames = (details: unknown): string[] => {
  const fields = (details as { fields?: Record<string, unknown> } | undefined)?.fields;
  return fields === undefined ? [] : Object.keys(fields);
};
