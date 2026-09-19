/**
 * `pnpm check:blind` —— C 层人工质量验收的**材料生成工具**（`docs/prd/spec/07-验收标准.md` §4）。
 *
 * 产出四件材料到 `--out <目录>`（缺省 `./blind-runs/<YYYY-MM-DD>`）：
 * `sheet.html`（盲测页：每行 2 张图、随机左右、无标签）、`answer-key.json`（每行真实标签与左右顺序）、
 * `score-template.csv`（评分表表头 + 每行一条空记录）、`report.md`（空模板，含 `docs/prd/spec/00-总纲.md`
 * §4.4 的六项指标定义与计算方式）。
 *
 * 样本来源：生成图取本地 `generation_results`（父 `generations.status='succeeded'`）联 `photos`
 * （`kind='generated'`、`deleted_at IS NULL`），按 `generations.era_code` 分层各取最多 10 张，文件字节经
 * `getStorage().resolveAbs(storageKey)` 读盘后就地内联为 base64 data URI（页面自包含、无外链）；
 * 真实老照片取 `docs/老照片/` 与产出目录下的 `real/`（用户自备）。
 *
 * 边界（`docs/prd/tickets/T20-验收：自动化检查与端到端冒烟.md` §2）：本工具不下达最终判定、不调用任何
 * 远端接口、只在 `--out` 目录内写文件；样本集为空（没有 `succeeded` 的生成结果）时照常产出四件材料并退出码 0。
 * 措辞遵守 `docs/prd/spec/06-合规与风控.md` §9.1 的禁用词清单与 `docs/prd/pages/P00-设计基准与路由.md` §9.1 的语气。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { getDb } from '../src/server/db/connection';
import { getStorage } from '../src/server/storage';

/** 每个年代层最多取多少张生成图（`docs/prd/spec/07-验收标准.md` §4）。 */
const MAX_PER_ERA = 10;
/** 真实老照片的固定来源目录（`docs/prd/spec/07-验收标准.md` §4）。 */
const REAL_DIR = path.join('docs', '老照片');
/** 用户自备真实照片的子目录名（相对产出目录）。 */
const REAL_SUBDIR = 'real';
/** 真实老照片与生成图组成的行头（`docs/prd/spec/07-验收标准.md` §4）。 */
const CSV_HEADER = '行号,选的哪张是AI,年代像不像(1-5),年龄是否偏年轻(是/否),是否塑料感(是/否),备注';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

type AiSide = 'left' | 'right';

interface GeneratedSample {
  generationId: number;
  resultId: number;
  photoId: number;
  eraCode: string;
  storageKey: string;
  /** 磁盘上的绝对路径（`getStorage().resolveAbs(storageKey)`），供内联 base64 读取。 */
  file: string;
  mime: string;
}

interface RealSample {
  file: string;
  mime: string;
}

interface SheetRow {
  row: number;
  real: RealSample;
  generated: GeneratedSample;
  aiSide: AiSide;
}

interface BlindContext {
  outDir: string;
  generatedTotal: number;
  perEra: { eraCode: string; picked: number }[];
  realTotal: number;
  rows: SheetRow[];
  realReused: boolean;
  notes: string[];
}

const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** 解析 `--out <目录>`；缺省 `./blind-runs/<YYYY-MM-DD>`。 */
const parseOutDir = (argv: string[]): string => {
  const index = argv.indexOf('--out');
  if (index === -1) return path.join('blind-runs', dayKey(new Date()));
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--out 需要一个目录参数，例如 --out ./blind-runs/2026-09-17');
  }
  return value;
};

const mimeOf = (file: string): string => MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'image/jpeg';

/** 目录下的图片文件（按文件名排序，便于复现）；目录不存在时返回空数组。 */
const listImages = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() in MIME_BY_EXT)
    .map((entry) => path.join(dir, entry.name))
    .sort();
};

/** 取各年代层最多 10 张生成图；库或表缺失时返回空集合并记一条说明（不失败）。 */
const readGeneratedSamples = (notes: string[]): GeneratedSample[] => {
  interface GeneratedRow {
    result_id: number;
    generation_id: number;
    photo_id: number;
    era_code: string;
    storage_key: string;
    mime: string;
  }
  let raw: GeneratedRow[];
  try {
    raw = getDb()
      .prepare(
        `SELECT r.id AS result_id, r.generation_id, r.photo_id, g.era_code, p.storage_key, p.mime
           FROM generation_results r
           JOIN generations g ON g.id = r.generation_id
           JOIN photos p ON p.id = r.photo_id
          WHERE g.status = 'succeeded' AND p.kind = 'generated' AND p.deleted_at IS NULL
          ORDER BY g.era_code, r.id`,
      )
      .all() as GeneratedRow[];
  } catch (err) {
    notes.push(`读库失败，本次按空样本集处理：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const perEra = new Map<string, GeneratedSample[]>();
  const missing: string[] = [];
  for (const row of raw) {
    const picked = perEra.get(row.era_code) ?? [];
    if (picked.length >= MAX_PER_ERA) continue;
    const storageKey = row.storage_key;
    let file: string;
    try {
      file = getStorage().resolveAbs(storageKey);
    } catch (err) {
      missing.push(storageKey);
      continue;
    }
    if (!fs.existsSync(file)) {
      missing.push(storageKey);
      continue;
    }
    picked.push({
      generationId: row.generation_id,
      resultId: row.result_id,
      photoId: row.photo_id,
      eraCode: row.era_code,
      storageKey,
      file,
      mime: row.mime,
    });
    perEra.set(row.era_code, picked);
  }

  const samples: GeneratedSample[] = [...perEra.keys()].sort().flatMap((era) => perEra.get(era) ?? []);
  if (missing.length > 0) {
    notes.push(`有 ${missing.length} 张生成图在磁盘上找不到，已跳过：${missing.join('、')}`);
  }
  return samples;
};

/** 真实老照片池：`docs/老照片/` + 产出目录下 `real/`（用户自备）。 */
const readRealSamples = (outDir: string): RealSample[] =>
  [...listImages(REAL_DIR), ...listImages(path.join(outDir, REAL_SUBDIR))].map((file) => ({
    file,
    mime: mimeOf(file),
  }));

/** 就地内联为 data URI：页面自包含，不引用任何外部文件（`docs/prd/spec/07-验收标准.md` §4）。 */
const dataUri = (file: string, mime: string): string =>
  `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

/** Fisher–Yates，随机源用 `node:crypto`（行序与左右都不可预测）。 */
const shuffle = <T>(items: T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
};

/** 组行：一行 = 一张真实老照片 + 一张生成图；真实池不足时按顺序循环复用。 */
const buildRows = (samples: GeneratedSample[], reals: RealSample[]): { rows: SheetRow[]; reused: boolean } => {
  if (samples.length === 0 || reals.length === 0) return { rows: [], reused: false };
  const rows = shuffle(samples).map((generated, index) => {
    const real = reals[index % reals.length];
    if (real === undefined) throw new Error('真实老照片池为空');
    return {
      row: index + 1,
      real,
      generated,
      aiSide: (randomInt(2) === 0 ? 'left' : 'right') as AiSide,
    };
  });
  return { rows, reused: samples.length > reals.length };
};

/** 盲测页：每行两张图、随机左右、**无标签 / 无文件名 / 无说明文字**，只给行号。 */
const buildSheetHtml = (ctx: BlindContext): string => {
  const head = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>盲测页</title>',
    '<style>',
    ':root { color-scheme: light; }',
    'body { margin: 0; background: #FBF7F1; color: #3B322A;',
    '  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.7; }',
    'main { max-width: 1100px; margin: 0 auto; padding: 40px 24px 64px; }',
    'h1 { font-size: 24px; font-weight: 500; margin: 0 0 8px; }',
    'p { margin: 0 0 12px; color: #6B5F53; }',
    'code { font-family: Consolas, monospace; font-size: 14px; }',
    '.rows { margin-top: 32px; }',
    '.row { background: #FFFCF7; border: 1px solid #E8DFD2; border-radius: 12px;',
    '  padding: 16px; margin-bottom: 24px; display: grid; grid-template-columns: 64px 1fr 1fr; gap: 16px; align-items: start; }',
    '.no { color: #6B5F53; font-size: 14px; padding-top: 4px; }',
    '.slot img { display: block; width: 100%; height: auto; border-radius: 8px; background: #F2ECE2; }',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '<h1>盲测页</h1>',
    '<p>每行两张图，顺序是随机的。请只看画面，判断哪一张是 AI 生成的，再判断另一张像不像那个年代拍的。</p>',
    '<p>按行号把结果填进 <code>score-template.csv</code>。</p>',
    '<p>评审前不要打开 <code>answer-key.json</code>（那是答案卡），也不要打开 <code>report.md</code>（里面写了样本构成）。</p>',
  ];
  if (ctx.rows.length === 0) {
    head.push('<p>本次没有可用的样本，这一页是空页。请先跑通链路、拿到成功的生成结果，再重跑本工具。</p>');
  }

  const body = ctx.rows.flatMap((row) => {
    const left = row.aiSide === 'left' ? row.generated : row.real;
    const right = row.aiSide === 'left' ? row.real : row.generated;
    return [
      '<div class="row">',
      `<div class="no">第 ${row.row} 行</div>`,
      `<div class="slot"><img alt="" src="${dataUri(left.file, left.mime)}"></div>`,
      `<div class="slot"><img alt="" src="${dataUri(right.file, right.mime)}"></div>`,
      '</div>',
    ];
  });
  const tail = ['</section>', '</main>', '</body>', '</html>', ''];
  return [...head, '<section class="rows">', ...body, ...tail].join('\n');
};

/** 答案卡：每行两侧的真实标签与左右顺序（哪一侧是生成图）。「评审前不要打开」的提示只落在盲测页与报告里。 */
const buildAnswerKey = (ctx: BlindContext): string =>
  `${JSON.stringify(
    {
      产出目录: ctx.outDir,
      行数: ctx.rows.length,
      行: ctx.rows.map((row) => ({
        row: row.row,
        left: row.aiSide === 'left' ? 'generated' : 'real',
        right: row.aiSide === 'right' ? 'generated' : 'real',
        aiSide: row.aiSide,
        realSide: row.aiSide === 'left' ? 'right' : 'left',
        generated: {
          generationId: row.generated.generationId,
          resultId: row.generated.resultId,
          photoId: row.generated.photoId,
          eraCode: row.generated.eraCode,
          storageKey: row.generated.storageKey,
        },
        real: { file: row.real.file.split(path.sep).join('/') },
      })),
    },
    null,
    2,
  )}\n`;

/** 评分表：表头逐字照抄 `docs/prd/spec/07-验收标准.md` §4，每行号一条空记录。 */
const buildScoreCsv = (ctx: BlindContext): string =>
  `${[CSV_HEADER, ...ctx.rows.map((row) => `${row.row},,,,,`)].join('\n')}\n`;

/** 报告：空模板 + `docs/prd/spec/00-总纲.md` §4.4 的六项指标定义与计算方式。 */
const buildReport = (ctx: BlindContext): string => {
  const lines: string[] = [
    '# 盲测评审报告（空模板）',
    '',
    '> 本文件由 `pnpm check:blind` 生成，只是一份空模板；口径与四件产物见 `docs/prd/spec/07-验收标准.md` §4。',
    '> 本工具不下达最终判定，判定由评审填写。评审前不要打开 `answer-key.json`，也不要先看本文件的「样本构成」一节。',
    '',
    '## 1. 评审组织要求',
    '',
    '盲测样本集至少 30 组源照片 + 生成结果，评审 ≥ 5 人，且包含**照片中人物的家属本人**。',
    '',
    '## 2. 样本构成',
    '',
    `- 产出目录：\`${ctx.outDir}\``,
    `- 行数：${ctx.rows.length}`,
    `- 生成图样本：${ctx.generatedTotal} 张（按 \`generations.era_code\` 分层，每层最多 ${MAX_PER_ERA} 张）`,
    ...ctx.perEra.map((era) => `  - ${era.eraCode}：${era.picked} 张`),
    `- 真实老照片池：${ctx.realTotal} 张（\`${REAL_DIR.split(path.sep).join('/')}/\` 与产出目录下的 \`${REAL_SUBDIR}/\`）`,
  ];
  if (ctx.rows.length === 0) {
    lines.push(
      '- **本次样本集为空**：本地没有 `succeeded` 的生成结果（或没有真实老照片），四件材料照常产出。',
      '  请先跑通链路拿到成功的生成结果、并把真实老照片放进上述目录，再重跑本工具。',
    );
  }
  if (ctx.realReused) {
    lines.push('- 真实老照片张数少于生成图张数，已按顺序循环复用真实照片池：同一张真实老照片会出现在多行。');
  }
  for (const note of ctx.notes) lines.push(`- ${note}`);
  lines.push(
    '',
    '## 3. 六项指标定义与计算方式',
    '',
    '出处：`docs/prd/spec/00-总纲.md` §4.4「可度量目标」。',
    '',
    '| 指标 | 定义 | 计算方式 | 目标 |',
    '|---|---|---|---|',
    '| 面部相似度 | 生成图与源照片人脸特征向量余弦相似度 | 逐行取同一源照片与生成图的特征向量余弦相似度，再取均值；需要人脸特征模型，本期不自动计算，列后续 ticket | ≥ 0.55 |',
    '| 年龄保真度 | 自动估计的年龄偏差绝对值 | 逐行取 `generation_results.age_delta`（结果侧年龄区间中值 − 锚点年龄区间中值）的绝对值，再看落在 5 岁以内的行占比 | ≤ 5 岁 |',
    '| 年代一致性 | 评审判断「像那个年代拍的」通过率 | 评分表「年代像不像(1-5)」记 ≥ 4 的行数 ÷ 总行数 | ≥ 70% |',
    '| 年代穿帮率 | 生成图出现该年代之后物件的比例 | 评审标注出穿帮物件的行数 ÷ 总行数 | ≤ 3% |',
    '| 盲测真实率 | 生成图被误判为真实老照片的比例 | 评分表「选的哪张是AI」与 `answer-key.json` 的 `aiSide` 相反的行数 ÷ 总行数 | ≥ 60% |',
    '| AI 感投诉率 | 评审/用户反馈「塑料感」的占比 | 评分表「是否塑料感」记「是」的行数 ÷ 总行数 | ≤ 5% |',
    '',
    '## 4. 逐行汇总（评审填写）',
    '',
    '| 行号 | 选的哪张是AI | 年代像不像(1-5) | 年龄是否偏年轻(是/否) | 是否塑料感(是/否) | 备注 |',
    '|---|---|---|---|---|---|',
    ...ctx.rows.map((row) => `| ${row.row} | | | | | |`),
    '',
    '## 5. 结论（评审填写）',
    '',
    '- 六项指标各自的实测值：',
    '- 未达标项与下一步动作：',
    '',
  );
  return lines.join('\n');
};

const main = (): void => {
  let outDir: string;
  try {
    outDir = parseOutDir(process.argv.slice(2));
  } catch (err) {
    console.error(`[blind] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  const notes: string[] = [];
  const samples = readGeneratedSamples(notes);
  const reals = readRealSamples(outDir);
  const { rows, reused } = buildRows(samples, reals);
  if (samples.length > 0 && reals.length === 0) {
    notes.push('没有找到真实老照片，本次没有组出任何一行；把真实老照片放进上述目录后重跑。');
  }

  const perEra = [...samples.reduce((map, sample) => map.set(sample.eraCode, (map.get(sample.eraCode) ?? 0) + 1), new Map<string, number>())]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([eraCode, picked]) => ({ eraCode, picked }));

  const ctx: BlindContext = {
    outDir,
    generatedTotal: samples.length,
    perEra,
    realTotal: reals.length,
    rows,
    realReused: reused,
    notes,
  };

  fs.writeFileSync(path.join(outDir, 'sheet.html'), buildSheetHtml(ctx), 'utf8');
  fs.writeFileSync(path.join(outDir, 'answer-key.json'), buildAnswerKey(ctx), 'utf8');
  fs.writeFileSync(path.join(outDir, 'score-template.csv'), buildScoreCsv(ctx), 'utf8');
  fs.writeFileSync(path.join(outDir, 'report.md'), buildReport(ctx), 'utf8');

  console.log(`[blind] 产出目录：${outDir}`);
  console.log(
    `[blind] 生成图样本 ${ctx.generatedTotal} 张（${perEra.map((era) => `${era.eraCode}=${era.picked}`).join(' ') || '无'}）、真实老照片池 ${ctx.realTotal} 张、组出 ${rows.length} 行`,
  );
  if (rows.length === 0) console.log('[blind] 本次样本集为空，四件材料照常产出');
  for (const note of notes) console.log(`[blind] 说明：${note}`);
  console.log('[blind] 已写出 sheet.html / answer-key.json / score-template.csv / report.md');
};

main();
