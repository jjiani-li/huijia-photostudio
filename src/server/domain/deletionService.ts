import { getDb } from '../db/connection';
import * as anchors from '../db/repositories/anchors';
import * as consents from '../db/repositories/consents';
import * as generations from '../db/repositories/generations';
import * as photos from '../db/repositories/photos';
import * as reverseJobs from '../db/repositories/promptReverseJobs';
import { audit } from '../security/audit';
import { appError } from './errors';
import { nowIso } from './time';
import type { Iso } from '../../shared/types';

/**
 * 彻底删除的级联编排（`docs/prd/modules/M08-账号历史与彻底删除.md` §3.3、§5.2）。
 * 级联解析顺序固定为「目标 → 受影响锚点 → 受影响 `generations` → 受影响 generated 照片 → 受影响反推任务」，
 * 全部落进**单个事务**；`consents` 只写 `revoked_at`（不删行），
 * `identity_anchors` / `generations` / `generation_results` / `prompt_reverse_jobs` 物理 DELETE，
 * `photos` 只软删（磁盘文件留给 `runPurge()`）。
 */
export interface PhotoCascaded {
  preprocessed: number;
  anchors: number;
  generations: number;
  results: number;
}

export interface AnchorCascaded {
  generations: number;
  results: number;
}

const ZERO_PHOTO: PhotoCascaded = { preprocessed: 0, anchors: 0, generations: 0, results: 0 };

/**
 * `DELETE /api/anchors/:id` 的锚点侧级联（`modules/M08` §3.3 的 `DELETE /api/anchors/:id` 规则表）：
 * 删该锚点的 `generations`（连 `generation_results`）与它们产物中的 generated 图，
 * 吊销该锚点的有效授权，清其反推任务；**不动**原图与预处理图。返回被删的 generations / results 数。
 */
export const cascadeFromAnchor = (userId: number, anchorId: number, at: Iso): AnchorCascaded => {
  const generationIds = generations.listIdsByAnchorIds([anchorId]);
  const generatedPhotoIds = photos.listGeneratedIdsByGenerationIds(generationIds);
  const results = generations.countResultsByGenerationIds(generationIds);
  photos.softDeletePhotos(generatedPhotoIds, at);
  consents.revokeByAnchor(anchorId, at);
  generations.deleteResultsByGenerationIds(generationIds);
  generations.hardDeleteGenerations(generationIds);
  reverseJobs.hardDeleteBySourcePhotos(generatedPhotoIds, userId);
  return { generations: generationIds.length, results };
};

/**
 * `DELETE /api/photos/:id`（`spec/03-接口契约.md` §3.2、`modules/M08` §3.3 的 `kind` 规则表）。
 * 幂等：目标不存在（含已被 `runPurge()` 物理清理）或已软删 → `200` 且 `cascaded` 全零（§9 第 2 条）；
 * 目标行属于其他用户 → `404 NOT_FOUND`（不返回 403，`API-04`）。
 */
export const deletePhoto = (params: {
  userId: number;
  photoId: number;
}): { ok: true; cascaded: PhotoCascaded } => {
  const db = getDb();
  return db.transaction(() => {
    const target = photos.findPhotoById(params.photoId);
    // 已物理清理 / 从未存在：按幂等返回 200（`spec/03` §1.5）。
    if (target === null) return { ok: true as const, cascaded: ZERO_PHOTO };
    if (target.userId !== params.userId) throw appError('NOT_FOUND');
    if (target.deletedAt !== null) return { ok: true as const, cascaded: ZERO_PHOTO };

    const at = nowIso();

    // ① 目标照片；`original` 还软删它派生的预处理图（`preprocessed` / `generated` 各自只软删自己）。
    // `cascaded.preprocessed` = 被标记的 `kind='preprocessed'` 行数（`modules/M08` §5.2）：
    // `original` 目标是派生图、`preprocessed` 目标是它自身（`generated` 目标不含预处理图）。
    const preprocessedIds =
      target.kind === 'original' ? photos.listPreprocessedIdsBySource(target.id) : [];
    const targetMarked = photos.softDeletePhoto(target.id, at);
    const preprocessed =
      (target.kind === 'original' ? photos.softDeletePhotos(preprocessedIds, at) : 0) +
      (target.kind === 'preprocessed' ? targetMarked : 0);

    // ②③④ 受影响锚点 → generations → generated 照片：每个锚点走同一段级联（`generated` 目标不触发）。
    const anchorIds =
      target.kind === 'generated'
        ? []
        : anchors.listAffectedIds(params.userId, target.id, target.kind === 'preprocessed');
    let generationCount = 0;
    let resultCount = 0;
    for (const anchorId of anchorIds) {
      const cascaded = cascadeFromAnchor(params.userId, anchorId, at);
      generationCount += cascaded.generations;
      resultCount += cascaded.results;
    }
    anchors.hardDeleteAnchors(anchorIds);

    // ⑤ 受影响反推任务（`source_photo_id` + `user_id` 级联，`spec/01` §3.15）。
    reverseJobs.hardDeleteBySourcePhotos([target.id, ...preprocessedIds], params.userId);

    audit({ action: 'photo.delete', userId: params.userId, target: `photo:${target.id}` }, at);
    for (const anchorId of anchorIds) {
      audit({ action: 'anchor.delete', userId: params.userId, target: `anchor:${anchorId}` }, at);
    }

    return {
      ok: true as const,
      cascaded: { preprocessed, anchors: anchorIds.length, generations: generationCount, results: resultCount },
    };
  })();
};

/**
 * `DELETE /api/anchors/:id`（`spec/03-接口契约.md` §3.3、`modules/M04-身份确认与授权.md` §5.4）：
 * 幂等物理删该锚点行 + 级联（`cascadeFromAnchor`）+ 写 `anchor.delete` 审计。
 * 行已物理删除 → `200` 且 `cascaded` 全零（`spec/03` §1.5）；行存在但属于其他用户 → `404 ANCHOR_NOT_FOUND`。
 */
export const deleteAnchor = (params: {
  userId: number;
  anchorId: number;
}): { ok: true; cascaded: AnchorCascaded } => {
  const ZERO: AnchorCascaded = { generations: 0, results: 0 };
  return getDb()
    .transaction(() => {
      const existing = anchors.findByIdForUser(params.userId, params.anchorId);
      if (existing === null) {
        // 已删除 → 200 幂等；存在（但属他人）→ 404（`API-04`）。
        if (anchors.findById(params.anchorId) !== null) throw appError('ANCHOR_NOT_FOUND');
        return { ok: true as const, cascaded: ZERO };
      }
      const at = nowIso();
      const cascaded = cascadeFromAnchor(params.userId, params.anchorId, at);
      anchors.hardDeleteAnchor(params.anchorId, params.userId);
      audit(
        {
          action: 'anchor.delete',
          userId: params.userId,
          target: `anchor:${params.anchorId}`,
          meta: { generations: cascaded.generations, results: cascaded.results },
        },
        at,
      );
      return { ok: true as const, cascaded };
    })
    .immediate();
};
