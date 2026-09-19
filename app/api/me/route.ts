import type { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '../../../src/server/http/respond';
import { requireUser } from '../../../src/server/auth/session';
import { readMe } from '../../../src/server/domain/authService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/me`（`docs/prd/spec/03-接口契约.md` §3.1）：当前用户 + 当日额度。
 * 组装（脱敏 + `readQuota()`）归 `domain/authService.readMe()`，handler 只做「鉴权 → 调 service → 封装」
 * （`spec/04-技术基线与目录结构.md` §3.1）。
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const session = requireUser(req);
  return ok(readMe(session.id));
});
