import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { runSeed } from '../db/seed';
import {
  readEraSceneConfig,
  type EraRecord,
  type EraSceneProfileRecord,
  type SceneRecord,
} from '../db/repositories/config';
import { buildPrompt, PROMPT_MAX_LENGTH, PROMPT_MIN_LENGTH } from './build';
import {
  AGE_PRESERVE_CLAUSE,
  IDENTITY_LEAD,
  PROMPT_TEMPLATE_VERSION,
  REALISM_ANCHOR,
  SECTION_AGE,
  SECTION_ERA,
  SECTION_ERA_FIT,
  SECTION_IDENTITY,
  SECTION_PROFILE,
  SECTION_REALISM,
  SECTION_SCENE,
} from './template';
import { CONFIDENCE_HINT_THRESHOLD, SEED_VERSION } from './versions';

/**
 * `buildPrompt` 的单元断言（`docs/prd/modules/M05-年代场景配置与Prompt拼装.md` §8）：
 * `PR-01`–`PR-09`（B 层在 `scripts/acceptance.ts` 的进程内形态）与 `PR-10`（A 层：文档与代码等值）。
 * 在临时库上跑真实 `runMigrations` + `runSeed`，20 组 (E,S) 全部来自种子。
 */
const ANCHOR_TEXT =
  '75-85岁老年男性，灰白短寸发型，发际线明显后退，额头宽阔有深横纹，方圆脸，细长单眼皮带眼袋，鼻头圆润嘴唇偏薄，面部有明显皱纹与少量老年斑，体型瘦高，无明显特殊痣疤';

const NEGATION_RE = /不要|禁止|no\s|without/;
const COLOR_ERA_WORDS_RE = /彩色胶卷|彩色颗粒|色彩/;

let tmpDir: string;
let eras: EraRecord[];
let scenes: SceneRecord[];
let profiles: EraSceneProfileRecord[];

interface Combo {
  era: EraRecord;
  scene: SceneRecord;
  profile: EraSceneProfileRecord;
  prompt: string;
}

let combos: Combo[];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-build-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
  closeDb();
  runMigrations();
  runSeed();
  const config = readEraSceneConfig();
  eras = config.eras;
  scenes = config.scenes;
  profiles = config.profiles;
  const eraByCode = new Map(eras.map((e) => [e.code, e]));
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  combos = profiles.map((profile) => {
    const era = eraByCode.get(profile.eraCode);
    const scene = sceneById.get(profile.sceneId);
    if (era === undefined || scene === undefined) throw new Error('种子组合引用了缺失的年代 / 场景');
    return { era, scene, profile, prompt: buildPrompt({ anchorText: ANCHOR_TEXT, era, scene, profile }).prompt };
  });
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

const eraOf = (code: string): EraRecord => {
  const era = eras.find((e) => e.code === code);
  if (era === undefined) throw new Error(`缺年代 ${code}`);
  return era;
};
const sceneOf = (id: number): SceneRecord => {
  const scene = scenes.find((s) => s.id === id);
  if (scene === undefined) throw new Error(`缺场景 ${id}`);
  return scene;
};

describe('PR-01 / PR-02 六个固定段落与固定顺序', () => {
  const order = [SECTION_IDENTITY, SECTION_AGE, SECTION_ERA, SECTION_SCENE, SECTION_REALISM, SECTION_ERA_FIT];

  it('20/20 含 6 个固定段落标签', () => {
    expect(combos).toHaveLength(20);
    for (const { prompt, era, scene } of combos) {
      for (const label of order) {
        expect(prompt.includes(label), `${era.code}x${scene.id} 缺 ${label}`).toBe(true);
      }
    }
  });

  it('20/20 首次出现位置严格递增', () => {
    for (const { prompt, era, scene } of combos) {
      const indices = order.map((label) => prompt.indexOf(label));
      for (let i = 1; i < indices.length; i += 1) {
        expect(indices[i], `${era.code}x${scene.id} 段落顺序错乱`).toBeGreaterThan(indices[i - 1] as number);
      }
    }
  });
});

describe('PR-03 禁止项正面化', () => {
  it('20/20 对否定词零命中', () => {
    for (const { prompt, era, scene } of combos) {
      expect(NEGATION_RE.test(prompt), `${era.code}x${scene.id} 出现否定词`).toBe(false);
    }
  });
});

describe('PR-04 防美化句', () => {
  it('20/20 含「不做任何美化」与「减龄」', () => {
    for (const { prompt, era, scene } of combos) {
      expect(prompt.includes('不做任何美化'), `${era.code}x${scene.id}`).toBe(true);
      expect(prompt.includes('减龄'), `${era.code}x${scene.id}`).toBe(true);
    }
  });
});

describe('PR-05 年代黑白影调', () => {
  it('E1 的 5 组含「黑白」且不含描述彩色的正向词', () => {
    const e1 = combos.filter((c) => c.era.code === 'E1');
    expect(e1).toHaveLength(5);
    for (const { prompt, scene } of e1) {
      expect(prompt.includes('黑白'), `E1x${scene.id}`).toBe(true);
      expect(COLOR_ERA_WORDS_RE.test(prompt), `E1x${scene.id} 出现彩色正向词`).toBe(false);
    }
  });
});

describe('PR-06 跨年代词汇污染', () => {
  it('E3 / E4 的 10 组不含「胶片」', () => {
    const digital = combos.filter((c) => c.era.code === 'E3' || c.era.code === 'E4');
    expect(digital).toHaveLength(10);
    for (const { prompt, era, scene } of digital) {
      expect(prompt.includes('胶片'), `${era.code}x${scene.id} 出现「胶片」`).toBe(false);
    }
  });
});

describe('PR-07 长度区间', () => {
  it('20/20 落在区间内，且不触发 warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const { era, scene, profile } of combos) {
      buildPrompt({ anchorText: ANCHOR_TEXT, era, scene, profile });
    }
    expect(warn).not.toHaveBeenCalled();
    for (const { prompt, era, scene } of combos) {
      expect(prompt.length, `${era.code}x${scene.id} 长度 ${prompt.length}`).toBeGreaterThanOrEqual(
        PROMPT_MIN_LENGTH,
      );
      expect(prompt.length, `${era.code}x${scene.id} 长度 ${prompt.length}`).toBeLessThanOrEqual(
        PROMPT_MAX_LENGTH,
      );
    }
    warn.mockRestore();
  });

  it('越界只 warn 不抛错、不截断', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const long = 'x'.repeat(1500);
    const result = buildPrompt({
      anchorText: long,
      era: eraOf('E1'),
      scene: sceneOf(1),
      profile: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(result.prompt.length).toBeGreaterThan(PROMPT_MAX_LENGTH);
    expect(result.prompt.includes(long)).toBe(true); // 未截断
    warn.mockRestore();
  });
});

describe('PR-08 确定性', () => {
  it('同输入两次拼接文本与哈希全等；哈希为 64 位小写十六进制', () => {
    const input = { anchorText: ANCHOR_TEXT, era: eraOf('E2'), scene: sceneOf(3), profile: null };
    const a = buildPrompt(input);
    const b = buildPrompt(input);
    expect(a.prompt).toBe(b.prompt);
    expect(a.promptHash).toBe(b.promptHash);
    expect(a.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.templateVersion).toBe(PROMPT_TEMPLATE_VERSION);
  });

  it('段间为单个 \\n（无空行）', () => {
    const noOverride = buildPrompt({ anchorText: ANCHOR_TEXT, era: eraOf('E1'), scene: sceneOf(1), profile: null });
    expect(noOverride.prompt.includes('\n\n')).toBe(false);
    expect(noOverride.prompt.split('\n')).toHaveLength(6);

    const withOverride = buildPrompt({
      anchorText: ANCHOR_TEXT,
      era: eraOf('E4'),
      scene: sceneOf(1),
      profile: profiles.find((p) => p.eraCode === 'E4' && p.sceneId === 1) ?? null,
    });
    expect(withOverride.prompt.includes('\n\n')).toBe(false);
    expect(withOverride.prompt.split('\n')).toHaveLength(7);
  });

  it('anchorText 内的换行原样保留', () => {
    const anchor = '第一行特征\n第二行特征';
    const { prompt } = buildPrompt({ anchorText: anchor, era: eraOf('E1'), scene: sceneOf(1), profile: null });
    expect(prompt.includes(`${SECTION_IDENTITY}${IDENTITY_LEAD}${anchor}`)).toBe(true);
  });
});

describe('PR-09 组合微调段的条件输出', () => {
  it('20/20：prompt_override 为 NULL 则无【组合微调】，非 NULL 则必含且在末尾', () => {
    for (const { profile, era, scene } of combos) {
      const { prompt } = buildPrompt({ anchorText: ANCHOR_TEXT, era, scene, profile });
      const hasSection = prompt.includes(SECTION_PROFILE);
      if (profile.promptOverride === null) {
        expect(hasSection, `${era.code}x${scene.id} 不该出现【组合微调】`).toBe(false);
      } else {
        expect(hasSection, `${era.code}x${scene.id} 缺【组合微调】`).toBe(true);
        expect(prompt.endsWith(`${SECTION_PROFILE}${profile.promptOverride}`)).toBe(true);
      }
    }
  });

  it('全空白 override 视同 NULL，整段省略', () => {
    const blankProfile: EraSceneProfileRecord = {
      id: -1,
      eraCode: 'E1',
      sceneId: 1,
      visualSignature: '',
      promptOverride: '   \n  ',
      confidence: 1,
      samplePhoto: null,
    };
    const { prompt } = buildPrompt({
      anchorText: ANCHOR_TEXT,
      era: eraOf('E1'),
      scene: sceneOf(1),
      profile: blankProfile,
    });
    expect(prompt.includes(SECTION_PROFILE)).toBe(false);
  });
});

// ── PR-10 文档与代码等值：spec/05 §2 结构示意块 ≡ 本文件的模板常量 / 种子顶层 ──────────────────

const LABEL_RE = /^【[^】]+】/;

/** 取 `docs/prd/spec/05-Prompt工程.md` §2 里以【身份锚点】开头的那段代码块（Markdown 折行保留原样）。 */
const readDocBlock = (): string[] => {
  const docPath = path.resolve(process.cwd(), 'docs/prd/spec/05-Prompt工程.md');
  const lines = fs.readFileSync(docPath, 'utf8').split('\n');
  let inFence = false;
  let block: string[] | null = null;
  for (const line of lines) {
    if (line.trim() === '```') {
      if (!inFence) {
        inFence = true;
        block = [];
      } else {
        inFence = false;
        if (block !== null && block.some((l) => l.startsWith(SECTION_IDENTITY))) return block;
        block = null;
      }
      continue;
    }
    if (inFence && block !== null) block.push(line);
  }
  throw new Error('docs/prd/spec/05-Prompt工程.md §2 找不到以【身份锚点】开头的代码块');
};

/** 按段落标签切块；段内多行是 Markdown 折行，去掉换行与缩进后拼接为一行。 */
const readDocBodies = (block: string[]): Map<string, string> => {
  const bodies = new Map<string, string>();
  let label: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (label !== null) bodies.set(label, buf.join(''));
  };
  for (const line of block) {
    const match = LABEL_RE.exec(line);
    if (match !== null) {
      flush();
      label = match[0];
      buf = [line.slice(match[0].length).trim()];
    } else if (label !== null) {
      buf.push(line.trim());
    }
  }
  flush();
  return bodies;
};

/** 去掉变量占位符 `<…>` 与「← 注释」后取正文。 */
const bodyOf = (bodies: Map<string, string>, label: string): string =>
  (bodies.get(label) ?? '').replace(/←.*$/, '').replace(/<[^>]*>/g, '').trim();

describe('PR-10 文档与代码等值', () => {
  const bodies = readDocBodies(readDocBlock());

  it('七个段落标签在文档块中都出现', () => {
    for (const label of [
      SECTION_IDENTITY,
      SECTION_AGE,
      SECTION_ERA,
      SECTION_SCENE,
      SECTION_REALISM,
      SECTION_ERA_FIT,
      SECTION_PROFILE,
    ]) {
      expect(bodies.has(label), `文档缺 ${label}`).toBe(true);
    }
  });

  it('段落正文与 template.ts 常量逐字符等值', () => {
    expect(bodyOf(bodies, SECTION_IDENTITY)).toBe(IDENTITY_LEAD);
    expect(bodyOf(bodies, SECTION_AGE)).toBe(AGE_PRESERVE_CLAUSE);
    expect(bodyOf(bodies, SECTION_REALISM)).toBe(REALISM_ANCHOR);
    expect(bodyOf(bodies, SECTION_ERA)).toBe('');
    expect(bodyOf(bodies, SECTION_SCENE)).toBe('');
    expect(bodyOf(bodies, SECTION_ERA_FIT)).toBe('');
    expect(bodyOf(bodies, SECTION_PROFILE)).toBe('');
  });

  it('年龄保真句与写实锚定词同时与 era-scene-seed.json 顶层逐字符一致', () => {
    const seedPath = path.resolve(process.cwd(), 'docs/prd/spec/era-scene-seed.json');
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as {
      version: string;
      realismAnchor: string;
      agePreserveClause: string;
      confidenceHintThreshold: number;
    };
    expect(AGE_PRESERVE_CLAUSE).toBe(seed.agePreserveClause);
    expect(REALISM_ANCHOR).toBe(seed.realismAnchor);
    expect(SEED_VERSION).toBe(seed.version);
    expect(CONFIDENCE_HINT_THRESHOLD).toBe(seed.confidenceHintThreshold);
  });
});
