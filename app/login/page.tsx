import { cookies } from 'next/headers';
import { LoginFlow } from '../../components/login-flow';

/**
 * `/login`（`docs/prd/pages/P00-设计基准与路由.md` §5.2）：服务端只做 `cookies().has('sid')` 软校验，
 * 真实数据（实名态）在 Client 组件里取。`next` 只接受站内路径，避免开放重定向。
 */
export const metadata = { title: '登录 · 回家照相馆' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const hasSession = (await cookies()).has('sid');
  const next = params.next !== undefined && params.next.startsWith('/') ? params.next : '/upload';
  return <LoginFlow hasSession={hasSession} next={next} />;
}
