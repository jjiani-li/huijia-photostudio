import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import { resetStorage } from '../storage';
import { insertPhoto } from '../db/repositories/photos';
import { insert as insertAnchor } from '../db/repositories/anchors';
import { insert as insertGeneration, insertResult, listResultsByGeneration } from '../db/repositories/generations';
import { insert as insertReverseJob } from '../db/repositories/promptReverseJobs';
import { ensureActive } from '../db/repositories/consents';
import { nowIso } from './time';
import { deleteAnchor, deletePhoto } from './deletionService';

/**
 * `tickets/T13` 的级联软删单测（`docs/prd/modules/M08-账号历史与彻底删除.md` §3.3、§5.2）：
 * `kind` 三分支的 `cascaded` 计数、幂等、归属 404、`consents` 不删行、审计留痕。
 */
let tmpDir: string;
const USER = 1;
const OTHER = 2;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-del-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  process.env.STORAGE_DIR = path.join(tmpDir, 'storage');
  closeDb();
  resetStorage();
  runMigrations();
  runSeed();
  getDb()
    .prepare("INSERT INTO users (id, phone, nickname, status, created_at) VALUES (?, '13900000000', 'OTHER', 1, ?)")
    .run(OTHER, nowIso());
});

afterAll(() => {
  closeDb();
  resetStorage();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.STORAGE_DIR;
});

const insertPhotoRow = (over: Partial<Parameters<typeof insertPhoto>[0]> = {}): number =>
  insertPhoto({
    userId: USER,
    kind: 'original',
    storageKey: `u${USER}/${Math.random()}.jpg`,
    mime: 'image/jpeg',
    bytes: 10,
    width: 100,
    height: 100,
    sha256: Math.random().toString(16).slice(2).padEnd(64, '0'),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
    ...over,
  }).id;

interface Chain {
  original: number;
  preprocessed: number;
  generated: number;
  anchorId: number;
  generationId: number;
  resultId: number;
}

/** 完整链路：原图 → 预处理图 → 锚点 → 生成 → 结果图（+ 反推任务、授权）。 */
const makeChain = (): Chain => {
  const original = insertPhotoRow({ kind: 'original' });
  const preprocessed = insertPhotoRow({ kind: 'preprocessed', sourcePhotoId: original });
  const anchorId = insertAnchor({
    userId: USER,
    inputPhotoIds: [original],
    preprocessedPhotoId: preprocessed,
    status: 'succeeded',
    attempt: 0,
    model: 'm',
    promptVersion: 'v1',
    quality: null,
    createdAt: nowIso(),
  }).id;
  const generationId = insertGeneration({
    userId: USER,
    anchorId,
    eraCode: 'E2',
    sceneId: 1,
    profileId: null,
    referencePhotoIds: [preprocessed],
    prompt: 'p',
    promptHash: 'a'.repeat(64),
    templateVersion: 'tpl',
    eraPackVersion: 'e',
    scenePackVersion: 's',
    model: 'm',
    params: { size: '2048x2048', outputFormat: 'png', watermark: false, provider: 'mock' },
    requestedCount: 1,
    status: 'succeeded',
    attempt: 0,
    createdAt: nowIso(),
  }).id;
  const generated = insertPhotoRow({ kind: 'generated', sourcePhotoId: null });
  insertResult({ generationId, photoId: generated, ordinal: 0, seed: null, eraCheck: null, ageDelta: null, createdAt: nowIso() });
  const resultId = (getDb().prepare('SELECT id FROM generation_results WHERE generation_id = ?').get(generationId) as { id: number }).id;
  insertReverseJob({ userId: USER, sourcePhotoId: original, model: 'vision', status: 'succeeded', attempt: 0, createdAt: nowIso() });
  ensureActive({ userId: USER, anchorId, scope: 'photo_usage', agreedAt: nowIso() });
  return { original, preprocessed, generated, anchorId, generationId, resultId };
};

const rowCount = (sql: string, ...params: unknown[]): number =>
  (getDb().prepare(sql).get(...params) as { n: number }).n;

const photoKind = (id: number): { deleted_at: string | null; kind: string } => {
  const row = getDb().prepare('SELECT kind, deleted_at FROM photos WHERE id = ?').get(id) as
    | { kind: string; deleted_at: string | null }
    | undefined;
  if (row === undefined) throw new Error(`photos ${id} 已不存在`);
  return row;
};

describe('deletePhoto · original 目标（§3.3 规则表首行）', () => {
  it('级联计数四键正确，链路上行从各表消失/软删，consents 只吊销不删行', () => {
    const chain = makeChain();
    const result = deletePhoto({ userId: USER, photoId: chain.original });

    expect(result.cascaded).toEqual({ preprocessed: 1, anchors: 1, generations: 1, results: 1 });
    expect(photoKind(chain.original).deleted_at).not.toBeNull();
    expect(photoKind(chain.preprocessed).deleted_at).not.toBeNull();
    expect(photoKind(chain.generated).deleted_at).not.toBeNull();
    expect(rowCount('SELECT COUNT(*) AS n FROM identity_anchors WHERE id = ?', chain.anchorId)).toBe(0);
    expect(rowCount('SELECT COUNT(*) AS n FROM generations WHERE id = ?', chain.generationId)).toBe(0);
    expect(rowCount('SELECT COUNT(*) AS n FROM generation_results WHERE id = ?', chain.resultId)).toBe(0);
    expect(
      rowCount('SELECT COUNT(*) AS n FROM prompt_reverse_jobs WHERE source_photo_id = ?', chain.original),
    ).toBe(0);
    const consents = getDb()
      .prepare('SELECT revoked_at FROM consents WHERE anchor_id = ?')
      .all(chain.anchorId) as { revoked_at: string | null }[];
    expect(consents).toHaveLength(1);
    expect(consents[0]?.revoked_at).not.toBeNull();
    expect(rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'photo.delete' AND target = ?", `photo:${chain.original}`)).toBe(1);
  });

  it('幂等：重复删除返回 200 且 cascaded 全零', () => {
    const chain = makeChain();
    deletePhoto({ userId: USER, photoId: chain.original });
    const again = deletePhoto({ userId: USER, photoId: chain.original });
    expect(again).toEqual({ ok: true, cascaded: { preprocessed: 0, anchors: 0, generations: 0, results: 0 } });
  });

  it('已物理清理（行不存在）→ 200 全零（spec/03 §1.5 幂等）', () => {
    const chain = makeChain();
    deletePhoto({ userId: USER, photoId: chain.original });
    getDb().prepare('DELETE FROM photos WHERE id = ?').run(chain.original);
    const again = deletePhoto({ userId: USER, photoId: chain.original });
    expect(again.cascaded).toEqual({ preprocessed: 0, anchors: 0, generations: 0, results: 0 });
  });

  it('他人照片 → 404 NOT_FOUND（不返回 403）', () => {
    const chain = makeChain();
    expect(() => deletePhoto({ userId: OTHER, photoId: chain.original })).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});

describe('deletePhoto · preprocessed 目标', () => {
  it('只软删该行 + 受影响 generations 的 generated 图；原图不动；preprocessed 计数含目标自身', () => {
    const chain = makeChain();
    const result = deletePhoto({ userId: USER, photoId: chain.preprocessed });
    expect(result.cascaded).toEqual({ preprocessed: 1, anchors: 1, generations: 1, results: 1 });
    expect(photoKind(chain.preprocessed).deleted_at).not.toBeNull();
    expect(photoKind(chain.generated).deleted_at).not.toBeNull();
    expect(photoKind(chain.original).deleted_at).toBeNull();
  });
});

describe('deletePhoto · generated 目标', () => {
  it('只软删该行，不动锚点 / generations / results', () => {
    const chain = makeChain();
    const result = deletePhoto({ userId: USER, photoId: chain.generated });
    expect(result.cascaded).toEqual({ preprocessed: 0, anchors: 0, generations: 0, results: 0 });
    expect(photoKind(chain.generated).deleted_at).not.toBeNull();
    expect(rowCount('SELECT COUNT(*) AS n FROM identity_anchors WHERE id = ?', chain.anchorId)).toBe(1);
    expect(rowCount('SELECT COUNT(*) AS n FROM generation_results WHERE id = ?', chain.resultId)).toBe(1);
  });

  it('软删后该结果不再出现在结果列表（spec/03 §3.6「只返回未软删除的照片」）', () => {
    const chain = makeChain();
    expect(listResultsByGeneration(chain.generationId)).toHaveLength(1);
    deletePhoto({ userId: USER, photoId: chain.generated });
    expect(listResultsByGeneration(chain.generationId)).toHaveLength(0);
  });
});

describe('deleteAnchor · §3.3 规则', () => {
  it('删锚点不删原图/预处理图，产出图软删、结果行与 generations 物理删、审计 anchor.delete', () => {
    const chain = makeChain();
    const before = rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'anchor.delete'");
    const result = deleteAnchor({ userId: USER, anchorId: chain.anchorId });
    expect(result.cascaded).toEqual({ generations: 1, results: 1 });
    expect(photoKind(chain.original).deleted_at).toBeNull();
    expect(photoKind(chain.preprocessed).deleted_at).toBeNull();
    expect(photoKind(chain.generated).deleted_at).not.toBeNull();
    expect(rowCount('SELECT COUNT(*) AS n FROM identity_anchors WHERE id = ?', chain.anchorId)).toBe(0);
    expect(rowCount("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'anchor.delete'")).toBe(before + 1);
  });

  it('不存在 / 已删除的锚点 → 404 ANCHOR_NOT_FOUND', () => {
    const chain = makeChain();
    expect(() => deleteAnchor({ userId: OTHER, anchorId: chain.anchorId })).toThrowError(
      expect.objectContaining({ code: 'ANCHOR_NOT_FOUND' }),
    );
  });

  it('幂等：重复删除返回 200 且 cascaded 全零（M04 §5.4、spec/03 §1.5）', () => {
    const chain = makeChain();
    deleteAnchor({ userId: USER, anchorId: chain.anchorId });
    const again = deleteAnchor({ userId: USER, anchorId: chain.anchorId });
    expect(again).toEqual({ ok: true, cascaded: { generations: 0, results: 0 } });
  });
});
