import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, withErrorHandling } from '../../../../src/server/http/respond';
import { parseJson } from '../../../../src/server/http/validate';
import { loginWithCode } from '../../../../src/server/domain/authService';
import { SID_COOKIE, SESSION_TTL_SECONDS } from '../../../../src/server/auth/session';
import { toApiUser } from '../../../../src/server/auth/mask';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/auth/login`（`docs/prd/spec/03-接口契约.md` §3.1）：校验顺序固定「存在/已消费 → 过期 → 码值」，
 * **免登录**；成功下发 `sid` cookie（`HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`）并返回用户（已脱敏）。
 */
const loginSchema = z.object({
  identifier: z.string().min(1),
  code: z.string().min(1),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = await parseJson(req, loginSchema);
  const { user, token } = loginWithCode({ identifier: body.identifier, code: body.code });
  const res = ok({ user: toApiUser(user) });
  res.cookies.set(SID_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
});
