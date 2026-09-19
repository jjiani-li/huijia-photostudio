import { appError } from '../domain/errors';
import { findById, type UserRecord } from '../db/repositories/users';

/**
 * M1/M2 的**鉴权桩**（`docs/prd/spec/08-本地开发指南.md` §3.2）：
 * 直接返回种子 `DEV_USER`（`docs/prd/spec/02-schema.sql` 的固定行，已实名），
 * **不读 cookie、不查 `sessions`**，使 `tickets/T03`–`tickets/T11` 的受保护端点能在
 * 没有真实登录流程时跑通。
 *
 * 出口：`tickets/T12-账号、会话与额度.md` 在**同一路径**把它替换为真实会话实现
 * （读 cookie → `sessions.token_hash` 校验），桩随之消失；回归项含 `API-03`。
 */
const DEV_USER_ID = 1;

export type { UserRecord };

export const getSessionUser = (): UserRecord | null => findById(DEV_USER_ID);

export const requireUser = (): UserRecord => {
  const user = getSessionUser();
  if (user === null) throw appError('UNAUTHENTICATED');
  return user;
};
