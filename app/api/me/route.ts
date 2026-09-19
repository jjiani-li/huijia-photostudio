import type { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '../../../src/server/http/respond';
import { appError } from '../../../src/server/domain/errors';
import { requireUser } from '../../../src/server/auth/session';
import { toApiUser } from '../../../src/server/auth/mask';
import { readQuota } from '../../../src/server/security/quota';
import { findById } from '../../../src/server/db/repositories/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/me`（`docs/prd/spec/03-接口契约.md` §3.1）：当前用户 + 当日额度。
 * `quota` 取 `readQuota()`（`tickets/T09` 下沉）；`phone` / `email` **必须**经 `mask.ts`（`API-05`）。
 * 本端点属 `spec/04-技术基线与目录结构.md` §3.1 允许直连 repository 的简单查询。
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const session = requireUser(req);
  const user = findById(session.id);
  if (user === null) throw appError('UNAUTHENTICATED');
  return ok({ user: toApiUser(user), quota: readQuota(session.id) });
});
