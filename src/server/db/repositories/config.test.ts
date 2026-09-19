import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../connection';
import { runMigrations } from '../migrate';
import { runSeed } from '../seed';
import { getEra, getProfile, getScene, readEraSceneConfig } from './config';

/**
 * `config` repository 语义（`docs/prd/modules/M05-年代场景配置与Prompt拼装.md` §3.1）：
 * 三张配置表只读、排序与 `is_active = 1` 过滤、恰 3 条 SQL（无 N+1）、`samplePhoto` 本期全为 `null`。
 */
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-configrepo-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  closeDb();
  runMigrations();
  runSeed();
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe('readEraSceneConfig 读取与排序', () => {
  it('返回 4 / 5 / 20 且按各自的排序键升序', () => {
    const config = readEraSceneConfig();
    expect(config.eras).toHaveLength(4);
    expect(config.scenes).toHaveLength(5);
    expect(config.profiles).toHaveLength(20);

    expect(config.eras.map((e) => e.sortOrder)).toEqual([1, 2, 3, 4]);
    expect(config.eras.map((e) => e.code)).toEqual(['E1', 'E2', 'E3', 'E4']);
    expect(config.scenes.map((s) => s.sortOrder)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < config.scenes.length; i += 1) {
      expect((config.scenes[i] as { id: number }).id).toBeGreaterThan(
        (config.scenes[i - 1] as { id: number }).id,
      );
    }
    const profileKeys = config.profiles.map((p) => `${p.eraCode}#${p.sceneId}`);
    expect(profileKeys).toEqual([...profileKeys].sort());
    expect(new Set(profileKeys).size).toBe(20);
  });

  it('本期 4 / 5 / 20 行的 samplePhoto 全为 null（不拼接、不占位）', () => {
    const config = readEraSceneConfig();
    expect(config.eras.every((e) => e.samplePhoto === null)).toBe(true);
    expect(config.scenes.every((s) => s.samplePhoto === null)).toBe(true);
    expect(config.profiles.every((p) => p.samplePhoto === null)).toBe(true);
  });

  it('只发 3 条 SQL（无 N+1）', () => {
    const spy = vi.spyOn(getDb(), 'prepare');
    readEraSceneConfig();
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});

describe('is_active = 1 过滤', () => {
  it('停用的行不出现在 readEraSceneConfig，getEra / getScene / getProfile 返回 null', () => {
    const db = getDb();
    db.prepare('UPDATE eras SET is_active = 0 WHERE code = ?').run('E1');
    db.prepare('UPDATE scenes SET is_active = 0 WHERE id = ?').run(1);
    db.prepare("UPDATE era_scene_profiles SET is_active = 0 WHERE era_code = 'E2' AND scene_id = 2").run();
    try {
      const config = readEraSceneConfig();
      expect(config.eras.map((e) => e.code)).toEqual(['E2', 'E3', 'E4']);
      expect(config.scenes).toHaveLength(4);
      expect(config.profiles).toHaveLength(19);
      expect(getEra('E1')).toBeNull();
      expect(getScene(1)).toBeNull();
      expect(getProfile('E2', 2)).toBeNull();
      expect(getEra('E2')?.code).toBe('E2');
      expect(getScene(2)?.id).toBe(2);
      expect(getProfile('E1', 1)?.eraCode).toBe('E1');
    } finally {
      db.prepare('UPDATE eras SET is_active = 1 WHERE code = ?').run('E1');
      db.prepare('UPDATE scenes SET is_active = 1 WHERE id = ?').run(1);
      db.prepare("UPDATE era_scene_profiles SET is_active = 1 WHERE era_code = 'E2' AND scene_id = 2").run();
    }
  });

  it('不存在的 code / id 与停用不可区分，均返回 null', () => {
    expect(getEra('E9')).toBeNull();
    expect(getScene(9999)).toBeNull();
    expect(getProfile('E9', 9999)).toBeNull();
  });
});
