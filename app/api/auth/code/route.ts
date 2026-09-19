import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, withErrorHandling } from '../../../../src/server/http/respond';
import { parseJson } from '../../../../src/server/http/validate';
import { requestLoginCode } from '../../../../src/server/domain/authService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `POST /api/auth/code`（`docs/prd/spec/03-接口契约.md` §3.1）：发验证码，**免登录**。
 * `channel` 缺省时按 `identifier` 是否含 `@` 自动判定；60 秒内重复发码 → `429 CODE_RATE_LIMITED`。
 */
const requestSchema = z.object({
  identifier: z.string().min(1),
  channel: z.enum(['phone', 'email']).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = await parseJson(req, requestSchema);
  const payload = requestLoginCode({
    identifier: body.identifier,
    ...(body.channel === undefined ? {} : { channel: body.channel }),
  });
  return ok(payload);
});
