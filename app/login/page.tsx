import { cookies } from 'next/headers';
import { LoginFlow } from '../../components/login-flow';

/**
 * `/login`（`docs/prd/pages/P00-设计基准与路由.md` §5.2）：服务端只做 `cookies().has('sid')` 软校验，
 * 真实数据（实名态）在 Client 组件里取。`next` 只接受站内路径（拒绝 `//host` 这类协议相对串），避免开放重定向。
 */
export const metadata = { title: '登录 · 回家照相馆' };

const safeNext = (raw: string | undefined): string =>
  raw !== undefined && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/upload';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const hasSession = (await cookies()).has('sid');
  return (
    <main className="mx-auto w-full max-w-content px-xl py-2xl">
      <LoginFlow hasSession={hasSession} next={safeNext(params.next)} />
    </main>
  );
}
