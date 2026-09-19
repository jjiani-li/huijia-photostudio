import type { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '../../../../src/server/http/respond';
import { logout } from '../../../../src/server/domain/authService';
import { SID_COOKIE } from '../../../../src/server/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/auth/logout`（`docs/prd/spec/03-接口契约.md` §3.1）：吊销会话（幂等）+ 清 cookie + `auth.logout` 审计。
 * 无会话 / 会话已失效时同样返回 `200 { ok: true }`（登出幂等，`spec/03` §1.5）。
 */
export const POST = withErrorHandling(async (req: NextRequest) => {
  logout(req);
  const res = ok({ ok: true });
  res.cookies.set(SID_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
});
