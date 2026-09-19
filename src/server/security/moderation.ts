import { insert as insertReview } from '../db/repositories/reviews';
import { nowIso } from '../domain/time';
import type { ModerationVerdict } from '../../shared/types';

/**
 * 上传阶段内容审核的**唯一入口**（`docs/prd/modules/M07-生成后复核与内容审核.md` §5.6）。
 * 无论内容审核判定取何值，都写**恰好一行** `content_reviews(stage='upload', target_type='photo')`。
 *
 * 本期（M1）判定恒为 `'pass'`：模型审核接入 `ArkProvider` 归
 * `tickets/T11-生成后复核与内容安全审核.md`；届时把判定改为由模型给出，`reject` 的软删与
 * `422 CONTENT_REJECTED` 由调用方 `photoService.uploadPhoto` 处理（`modules/M01` §6.1）。
 */
export const moderateUpload = (params: {
  userId: number;
  photoId: number;
  model?: string | null;
  now?: string;
}): ModerationVerdict => {
  const verdict: ModerationVerdict = 'pass';
  insertReview({
    userId: params.userId,
    stage: 'upload',
    targetType: 'photo',
    targetId: params.photoId,
    verdict,
    reason: null,
    model: params.model ?? null,
    createdAt: params.now ?? nowIso(),
  });
  return verdict;
};
