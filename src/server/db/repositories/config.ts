import { getDb } from '../connection';

/**
 * 配置资产 `eras` / `scenes` / `era_scene_profiles` 的只读读取
 * （`docs/prd/modules/M05-年代场景配置与Prompt拼装.md` §3.1）。
 * 三张表**只由 `pnpm seed` 写入**（`DB-08`），本文件只有 `SELECT`。
 */
export interface EraRecord {
  code: string;
  name: string;
  slug: string;
  isMono: boolean;
  defaultSize: string;
  styleJson: unknown;
  promptPack: string;
  constraintPack: string;
  caption: string;
  samplePhoto: string | null;
  packVersion: string;
  isActive: boolean;
  sortOrder: number;
}

export interface SceneRecord {
  id: number;
  code: string;
  name: string;
  slug: string;
  category: string | null;
  spacePack: string;
  caption: string;
  samplePhoto: string | null;
  packVersion: string;
  isActive: boolean;
  sortOrder: number;
}

export interface EraSceneProfileRecord {
  id: number;
  eraCode: string;
  sceneId: number;
  visualSignature: string;
  promptOverride: string | null;
  confidence: number;
  samplePhoto: string | null;
}

export interface EraSceneConfigRecord {
  eras: EraRecord[];
  scenes: SceneRecord[];
  profiles: EraSceneProfileRecord[];
}

interface EraRow {
  code: string;
  name: string;
  slug: string;
  is_mono: number;
  default_size: string;
  style_json: string;
  prompt_pack: string;
  constraint_pack: string;
  caption: string;
  sample_photo: string | null;
  pack_version: string;
  is_active: number;
  sort_order: number;
}

interface SceneRow {
  id: number;
  code: string;
  name: string;
  slug: string;
  category: string | null;
  space_pack: string;
  caption: string;
  sample_photo: string | null;
  pack_version: string;
  is_active: number;
  sort_order: number;
}

interface ProfileRow {
  id: number;
  era_code: string;
  scene_id: number;
  visual_signature: string;
  prompt_override: string | null;
  confidence: number;
  sample_photo: string | null;
}

const ERA_COLUMNS =
  'code, name, slug, is_mono, default_size, style_json, prompt_pack, constraint_pack, caption, sample_photo, pack_version, is_active, sort_order';
const SCENE_COLUMNS =
  'id, code, name, slug, category, space_pack, caption, sample_photo, pack_version, is_active, sort_order';
const PROFILE_COLUMNS =
  'id, era_code, scene_id, visual_signature, prompt_override, confidence, sample_photo';

const toEra = (row: EraRow): EraRecord => ({
  code: row.code,
  name: row.name,
  slug: row.slug,
  isMono: row.is_mono === 1,
  defaultSize: row.default_size,
  styleJson: JSON.parse(row.style_json) as unknown,
  promptPack: row.prompt_pack,
  constraintPack: row.constraint_pack,
  caption: row.caption,
  samplePhoto: row.sample_photo,
  packVersion: row.pack_version,
  isActive: row.is_active === 1,
  sortOrder: row.sort_order,
});

const toScene = (row: SceneRow): SceneRecord => ({
  id: row.id,
  code: row.code,
  name: row.name,
  slug: row.slug,
  category: row.category,
  spacePack: row.space_pack,
  caption: row.caption,
  samplePhoto: row.sample_photo,
  packVersion: row.pack_version,
  isActive: row.is_active === 1,
  sortOrder: row.sort_order,
});

const toProfile = (row: ProfileRow): EraSceneProfileRecord => ({
  id: row.id,
  eraCode: row.era_code,
  sceneId: row.scene_id,
  visualSignature: row.visual_signature,
  promptOverride: row.prompt_override,
  confidence: row.confidence,
  samplePhoto: row.sample_photo,
});

/** 配置端点：恰好 3 条 `SELECT`，随后在内存里组装（避免对 20 行 profile 逐行再查，`modules/M05` §3.1）。 */
export const readEraSceneConfig = (): EraSceneConfigRecord => {
  const db = getDb();
  const eras = (
    db
      .prepare(`SELECT ${ERA_COLUMNS} FROM eras WHERE is_active = 1 ORDER BY sort_order ASC, code ASC`)
      .all() as EraRow[]
  ).map(toEra);
  const scenes = (
    db
      .prepare(`SELECT ${SCENE_COLUMNS} FROM scenes WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`)
      .all() as SceneRow[]
  ).map(toScene);
  const profiles = (
    db
      .prepare(
        `SELECT ${PROFILE_COLUMNS} FROM era_scene_profiles WHERE is_active = 1 ORDER BY era_code ASC, scene_id ASC`,
      )
      .all() as ProfileRow[]
  ).map(toProfile);
  return { eras, scenes, profiles };
};

/** `is_active = 0` 与「不存在」对调用方不可区分，都返回 `null`（`modules/M05` §3.1）。 */
export const getEra = (code: string): EraRecord | null => {
  const row = getDb()
    .prepare(`SELECT ${ERA_COLUMNS} FROM eras WHERE code = ? AND is_active = 1`)
    .get(code) as EraRow | undefined;
  return row === undefined ? null : toEra(row);
};

export const getScene = (id: number): SceneRecord | null => {
  const row = getDb()
    .prepare(`SELECT ${SCENE_COLUMNS} FROM scenes WHERE id = ? AND is_active = 1`)
    .get(id) as SceneRow | undefined;
  return row === undefined ? null : toScene(row);
};

export const getProfile = (eraCode: string, sceneId: number): EraSceneProfileRecord | null => {
  const row = getDb()
    .prepare(
      `SELECT ${PROFILE_COLUMNS} FROM era_scene_profiles
       WHERE era_code = ? AND scene_id = ? AND is_active = 1`,
    )
    .get(eraCode, sceneId) as ProfileRow | undefined;
  return row === undefined ? null : toProfile(row);
};
