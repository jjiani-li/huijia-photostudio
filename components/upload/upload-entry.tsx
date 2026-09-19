'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ApiClientError, apiRequest } from '../../src/shared/api-client';
import { loginPath } from '../../src/shared/session';

/**
 * 首页的上传入口（`docs/prd/pages/P01-上传与身份确认.md` §4.1 的 `PrimaryAction`）：
 * 首页本身**不校验登录、不发任何请求**——登录态只在点这一下时探测：
 * `GET /api/me` 成功去 `/upload`，`401 UNAUTHENTICATED` 去登录页并保留 `next=/upload`。
 *
 * 其余失败（网络层）按「已登录」处理：`/upload` 自身的软守卫与页内 401 仍是最终判据
 * （`pages/P00-设计基准与路由.md` §5.1 规则 ③），这里不额外呈现错误。
 */
export function UploadEntry(): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onEnter = (): void => {
    setBusy(true);
    apiRequest<unknown>('/api/me')
      .then(() => router.push('/upload'))
      .catch((err: unknown) => {
        router.push(err instanceof ApiClientError && err.code === 'UNAUTHENTICATED' ? loginPath('/upload') : '/upload');
      })
      .finally(() => setBusy(false));
  };

  return (
    <button
      type="button"
      disabled={busy}
      onClick={onEnter}
      className="rounded-pill bg-primary px-2xl py-md text-body text-background disabled:bg-primary-soft disabled:text-ink-soft"
    >
      上传一张老照片
    </button>
  );
}
