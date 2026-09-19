import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getDb } from './connection';
import { isMain } from './cli';
import { nowIso } from '../domain/time';

/**
 * 种子写入器（`docs/prd/spec/01-领域模型与数据库.md` §5.2）：
 * 以 `docs/prd/spec/era-scene-seed.json`（唯一权威副本）**幂等 upsert**
 * `eras` / `scenes` / `era_scene_profiles`，并保证固定 `DEV_USER` 存在；
 * 结束后断言 4 / 5 / 20，不符则非零退出。
 */
const SEED_PATH = fileURLToPath(
  new URL('../../../docs/prd/spec/era-scene-seed.json', import.meta.url),
);

const eraSeed = z.object({
  code: z.string(),
  name: z.string(),
  slug: z.string(),
  isMono: z.boolean(),
  defaultSize: z.string(),
  caption: z.string(),
  packVersion: z.string(),
  sortOrder: z.number(),
  samplePhoto: z.string().nullable(),
  styleJson: z.unknown(),
  promptPack: z.string(),
  constraintPack: z.string(),
});

const sceneSeed = z.object({
  code: z.string(),
  name: z.string(),
  slug: z.string(),
  category: z.string().nullable(),
  caption: z.string(),
  packVersion: z.string(),
  sortOrder: z.number(),
  samplePhoto: z.string().nullable(),
  spacePack: z.string(),
});

const profileSeed = z.object({
  eraCode: z.string(),
  sceneCode: z.string(),
  confidence: z.number(),
  promptOverride: z.string().nullable(),
  visualSignature: z.string(),
  samplePhoto: z.string().nullable(),
});

const seedFile = z.object({
  version: z.string(),
  eras: z.array(eraSeed),
  scenes: z.array(sceneSeed),
  eraSceneProfiles: z.array(profileSeed),
});

/** 固定开发用户：已实名（`verified_at` 非空），使 M1/M2 不受生成门槛阻塞（`spec/08` §3.2）。 */
const DEV_USER = {
  id: 1,
  phone: '13800000000',
  nickname: 'DEV_USER',
  realName: '开发用户',
  idHash: 'dev-user-placeholder-hash',
  status: 1,
  dailyImageQuota: 20,
  createdAt: '2026-01-01T00:00:00Z',
  lastLoginAt: '2026-01-01T00:00:00Z',
  verifiedAt: '2026-01-01T00:00:00Z',
} as const;

export interface SeedResult {
  eras: number;
  scenes: number;
  profiles: number;
}

const UPSERT_ERA = `
INSERT INTO eras (code, name, slug, is_mono, default_size, style_json, prompt_pack,
                  constraint_pack, caption, sample_photo, pack_version, is_active, sort_order)
VALUES (@code, @name, @slug, @isMono, @defaultSize, @styleJson, @promptPack,
        @constraintPack, @caption, @samplePhoto, @packVersion, 1, @sortOrder)
ON CONFLICT(code) DO UPDATE SET
  name = excluded.name, slug = excluded.slug, is_mono = excluded.is_mono,
  default_size = excluded.default_size, style_json = excluded.style_json,
  prompt_pack = excluded.prompt_pack, constraint_pack = excluded.constraint_pack,
  caption = excluded.caption, sample_photo = excluded.sample_photo,
  pack_version = excluded.pack_version, is_active = 1, sort_order = excluded.sort_order`;

const UPSERT_SCENE = `
INSERT INTO scenes (code, name, slug, category, space_pack, caption, sample_photo,
                    pack_version, is_active, sort_order)
VALUES (@code, @name, @slug, @category, @spacePack, @caption, @samplePhoto,
        @packVersion, 1, @sortOrder)
ON CONFLICT(code) DO UPDATE SET
  name = excluded.name, slug = excluded.slug, category = excluded.category,
  space_pack = excluded.space_pack, caption = excluded.caption,
  sample_photo = excluded.sample_photo, pack_version = excluded.pack_version,
  is_active = 1, sort_order = excluded.sort_order`;

const UPSERT_PROFILE = `
INSERT INTO era_scene_profiles (era_code, scene_id, visual_signature, prompt_override,
                                confidence, sample_photo, is_active)
VALUES (@eraCode, @sceneId, @visualSignature, @promptOverride, @confidence, @samplePhoto, 1)
ON CONFLICT(era_code, scene_id) DO UPDATE SET
  visual_signature = excluded.visual_signature, prompt_override = excluded.prompt_override,
  confidence = excluded.confidence, sample_photo = excluded.sample_photo, is_active = 1`;

const UPSERT_DEV_USER = `
INSERT INTO users (id, phone, nickname, real_name, id_hash, status, daily_image_quota,
                   created_at, last_login_at, verified_at)
VALUES (@id, @phone, @nickname, @realName, @idHash, @status, @dailyImageQuota,
        @createdAt, @lastLoginAt, @verifiedAt)
ON CONFLICT(id) DO NOTHING`;

export const runSeed = (): SeedResult => {
  const db = getDb();
  const data = seedFile.parse(JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')));

  db.transaction(() => {
    const insertEra = db.prepare(UPSERT_ERA);
    for (const era of data.eras) {
      insertEra.run({
        code: era.code,
        name: era.name,
        slug: era.slug,
        isMono: era.isMono ? 1 : 0,
        defaultSize: era.defaultSize,
        styleJson: JSON.stringify(era.styleJson),
        promptPack: era.promptPack,
        constraintPack: era.constraintPack,
        caption: era.caption,
        samplePhoto: era.samplePhoto,
        packVersion: era.packVersion,
        sortOrder: era.sortOrder,
      });
    }

    const insertScene = db.prepare(UPSERT_SCENE);
    const sceneIdByCode = new Map<string, number>();
    for (const scene of data.scenes) {
      insertScene.run({
        code: scene.code,
        name: scene.name,
        slug: scene.slug,
        category: scene.category,
        spacePack: scene.spacePack,
        caption: scene.caption,
        samplePhoto: scene.samplePhoto,
        packVersion: scene.packVersion,
        sortOrder: scene.sortOrder,
      });
      const row = db.prepare('SELECT id FROM scenes WHERE code = ?').get(scene.code) as
        | { id: number }
        | undefined;
      if (row === undefined) throw new Error(`种子写入后找不到场景 ${scene.code}`);
      sceneIdByCode.set(scene.code, row.id);
    }

    const insertProfile = db.prepare(UPSERT_PROFILE);
    for (const profile of data.eraSceneProfiles) {
      const sceneId = sceneIdByCode.get(profile.sceneCode);
      if (sceneId === undefined) throw new Error(`组合引用了未知场景 ${profile.sceneCode}`);
      insertProfile.run({
        eraCode: profile.eraCode,
        sceneId,
        visualSignature: profile.visualSignature,
        promptOverride: profile.promptOverride,
        confidence: profile.confidence,
        samplePhoto: profile.samplePhoto,
      });
    }

    db.prepare(UPSERT_DEV_USER).run(DEV_USER);
  })();

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const result: SeedResult = {
    eras: count('eras'),
    scenes: count('scenes'),
    profiles: count('era_scene_profiles'),
  };
  if (result.eras !== 4 || result.scenes !== 5 || result.profiles !== 20) {
    throw new Error(
      `种子数量断言失败：期望 4/5/20，实际 ${result.eras}/${result.scenes}/${result.profiles}`,
    );
  }
  return result;
};

if (isMain(import.meta.url)) {
  const result = runSeed();
  console.log(
    JSON.stringify({
      level: 'info',
      scope: 'seed',
      msg: 'config assets seeded',
      ...result,
      at: nowIso(),
    }),
  );
}
