import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '../../../../src/server/http/respond';
import { parseJson } from '../../../../src/server/http/validate';
import { requireUser } from '../../../../src/server/auth/session';
import { readRealNameStatus, submitRealName } from '../../../../src/server/domain/authService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET` / `POST /api/me/realname`（`docs/prd/spec/03-接口契约.md` §3.1、`modules/M08-账号历史与彻底删除.md` §2.2）：
 * `GET` 读 `RealNameStatus`；`POST` 过 `IdVerifyProvider` 后写 `users` 三列并同事务写审计。
 * 字段逐字对齐契约（`{ realName, idNumber }` → `{ realNameStatus }`）；格式规则的判定在
 * `auth/idVerify.ts`（zod 只负责「字段存在且是字符串」，好让 `details.fields` 的键名与契约一致）。
 */
const realNameSchema = z.object({
  realName: z.string(),
  idNumber: z.string(),
});

export const GET = withErrorHandling(async (req: NextRequest) => {
  const user = requireUser(req);
  return ok({ realNameStatus: readRealNameStatus(user.id) });
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const user = requireUser(req);
  const body = await parseJson(req, realNameSchema);
  return ok({ realNameStatus: submitRealName(user.id, body) });
});
