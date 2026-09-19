import { findByIdForUser } from '../db/repositories/anchors';
import { hasActiveScope } from '../db/repositories/consents';
import { appError } from './errors';

/**
 * `POST /api/generations` 前置校验里归本模块的两步（`docs/prd/modules/M04-身份确认与授权.md` §5.3）：
 * ① 锚点可用性（`status='succeeded'` 且 `confirmed_by_user=1`）→ `409 ANCHOR_NOT_CONFIRMED`（**先**）；
 * ② `photo_usage` 存在未吊销授权 → `403 CONSENT_REQUIRED`（**后**）。顺序固定，
 * `SEC-01` 因此不依赖测试数据里是否存在 `consents` 行；锚点归属先于权限——不存在 / 他人
 * → `404 ANCHOR_NOT_FOUND`（不返回 403，`API-04`）。
 *
 * 完整的 8 步序列（实名 / `count` / era-scene / 额度 / 非终态）与单事务入队由 `tickets/T09`
 * 在同一文件补上，并在其 `createGeneration` 里调用本函数
 * （`modules/M06-生成编排.md` §5.1 第 4–6 步）。
 */
export const assertAnchorGeneratable = (userId: number, anchorId: number): void => {
  const anchor = findByIdForUser(userId, anchorId);
  if (anchor === null) throw appError('ANCHOR_NOT_FOUND');
  if (anchor.status !== 'succeeded' || anchor.confirmedByUser !== 1) {
    throw appError('ANCHOR_NOT_CONFIRMED');
  }
  if (!hasActiveScope(userId, 'photo_usage')) throw appError('CONSENT_REQUIRED');
};
