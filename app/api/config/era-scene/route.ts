import { ok, withErrorHandling } from '../../../../src/server/http/respond';
import { requireUser } from '../../../../src/server/auth/session';
import { readEraSceneConfig, type EraRecord, type EraSceneProfileRecord, type SceneRecord } from '../../../../src/server/db/repositories/config';
import {
  CONFIDENCE_HINT_THRESHOLD,
  REALISM_ANCHOR,
  SEED_VERSION,
} from '../../../../src/server/prompt/versions';
import type { EraOption, EraSceneConfig, EraSceneProfile, SceneOption } from '../../../../src/shared/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/config/era-scene`（`docs/prd/spec/03-接口契约.md` §3.4；`docs/prd/modules/M05-年代场景配置与Prompt拼装.md` §4.1）。
 *
 * 三张只读配置表 → 白名单组装：**不下发 prompt 正文**（`promptPack` / `spacePack` / `constraintPack` /
 * `promptOverride`，`API-06`），也不下发 `styleJson` / `packVersion` / `isActive`。`samplePhoto` 三态原样
 * 透传为 `sampleUrl` / `coverUrl`，`null` 时前端降级为纯文字（本期全部为 `null`）。
 */

/** `eras` 行 → `EraOption`（白名单，`samplePhoto` → `sampleUrl` 原样透传）。 */
const toEraOption = (era: EraRecord): EraOption => ({
  code: era.code,
  name: era.name,
  slug: era.slug,
  isMono: era.isMono,
  caption: era.caption,
  sampleUrl: era.samplePhoto,
  sortOrder: era.sortOrder,
});

/** `scenes` 行 → `SceneOption`（白名单，`samplePhoto` → `coverUrl` 原样透传）。 */
const toSceneOption = (scene: SceneRecord): SceneOption => ({
  id: scene.id,
  code: scene.code,
  name: scene.name,
  slug: scene.slug,
  category: scene.category,
  caption: scene.caption,
  coverUrl: scene.samplePhoto,
  sortOrder: scene.sortOrder,
});

/** `era_scene_profiles` 行 → `EraSceneProfile`（白名单，`samplePhoto` → `sampleUrl` 原样透传）。 */
const toProfileOption = (profile: EraSceneProfileRecord): EraSceneProfile => ({
  eraCode: profile.eraCode,
  sceneId: profile.sceneId,
  confidence: profile.confidence,
  visualSignature: profile.visualSignature,
  sampleUrl: profile.samplePhoto,
});

export const GET = withErrorHandling(async (req: Request) => {
  requireUser(req);
  const config = readEraSceneConfig();
  const body: EraSceneConfig = {
    version: SEED_VERSION,
    confidenceHintThreshold: CONFIDENCE_HINT_THRESHOLD,
    realismAnchor: REALISM_ANCHOR,
    eras: config.eras.map(toEraOption),
    scenes: config.scenes.map(toSceneOption),
    profiles: config.profiles.map(toProfileOption),
  };
  return ok(body);
});
