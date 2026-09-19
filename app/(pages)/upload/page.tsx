import { Suspense } from 'react';
import type { ReactNode } from 'react';
import { UploadPanel } from '../../../components/upload/upload-panel';
import { UploadSkeleton } from '../../../components/upload/upload-view';

/**
 * `/upload`（`docs/prd/pages/P01-上传与身份确认.md` §2、`pages/P00-设计基准与路由.md` §5.1）：
 * Server Component 只做骨架——本页没有动态段（不解析参数、不发请求），登录软校验在
 * `app/(pages)/layout.tsx`，真实数据一律由 `UploadPanel` 经 `api-client` 取。
 * `Suspense` 的 fallback 是客户端容器首次挂载时的骨架（同 `choose` / `result` 两页的写法）。
 */
export default function UploadPage(): ReactNode {
  return (
    <Suspense fallback={<UploadSkeleton />}>
      <UploadPanel />
    </Suspense>
  );
}
