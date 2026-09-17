#!/usr/bin/env node
/**
 * check:docs —— 文档闸门。
 *
 * 断言 `docs/prd/` 文档树与 `spec/check-registry.json` 自洽，共 11 条：
 *   1. ids-unique            检查项 ID 全局唯一
 *   2. single-owner          每个 ID 恰有一个归属文档与一条认领工单
 *   3. no-orphan             每个 ID 至少被一条工单表头认领
 *   4. declared-ids-exist    文档里出现的 ID 都已注册（含已退役 ID 不得复现）
 *   5. single-new            每份文件只有一处「新建」声明，且路径必须是完整仓库相对路径
 *   6. refs-resolve          被引用的文件、章节与归属文档都存在
 *   7. index-matches-headers 工单索引的检查项列 ≡ 各工单表头
 *   8. counts-match-registry 文档写出的检查项计数 ≡ 注册表派生值
 *   9. error-single-source   错误码表只存在于 `spec/03-接口契约.md` §5（不复述状态码与用户文案）
 *  10. threshold-single-source prompt 长度区间只在 `spec/07-验收标准.md` 声明一次
 *  11. task-source-single-count 任务来源「几张表」全库只有一个说法（三张）
 * * 只读文件系统，不依赖环境变量、凭证或产品进程。
 * 用法：node scripts/check-docs.mjs [--root <docs/prd>] [--write-index]
 *   --root         指定文档树根（默认 <仓库根>/docs/prd），测试夹具用
 *   --write-index  按工单表头重写 tickets/README.md 的检查项列（其余断言照跑）
 *
 * 规则边界（不改代码就别指望它替你抓的东西）：
 *   - 引用只校验指向 `docs/prd/` 内部文档的（`spec|modules|pages|tickets/` 与 `README.md`）；
 *     指向 `docs/raw/`、`docs/火山引擎接口文档.md` 等上游输入的引用不查（编号不归本仓库管）。
 *   - `§N.M` 只在「第 N 节确实有 `### N.x` 编号子节」时校验；`§N.M` 也可能表示
 *     「第 N 节第 M 条」，那种写法无法静态判定，不查。
 *   - 根目录下的文件名必须在下面的 ROOT_FILES 白名单里（新增根文件时补一行）。
 *   - 代码路径（`src/**`、`app/**`、`fixtures/**`）由产品工单声明，本仓库尚未实现，
 *     因此只查声明唯一，不查存在。
 *   - 单点化三条（9–11）按**已知写法**判定：错误码表看「首格是反引号包的错误码」+「含状态码或
 *     文案列」；阈值看固定的几个字面写法；表数看「任务来源 / 任务表」所在行。换一种写法就能绕过，
 *     但改契约的写法本身也是改契约，评审会看见。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  if (i !== -1) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
};
const WRITE_INDEX = argv.includes('--write-index');
const PRD = path.resolve(valueOf('--root') ?? path.join(REPO, 'docs/prd'));

const ROOT_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'next.config.mjs',
  'next-env.d.ts',
  'tailwind.config.ts',
  'postcss.config.mjs',
  'vitest.config.ts',
  '.env.example',
  '.gitignore',
  '.env',
  'README.md',
  'AGENTS.md',
]);
const ID_BODY = '[A-Z][A-Z0-9]{1,3}-\\d{2}';
const ID_SHAPE = new RegExp(`\\b${ID_BODY}\\b`, 'g');
const ID_TOKEN = new RegExp(`^${ID_BODY}$`);
const BACKTICKED = (s) => [...s.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const DOC_REF =
  /(?:docs\/prd\/)?(?:spec|modules|pages|tickets)\/[A-Za-z0-9\u4e00-\u9fa5_.-]+\.(?:md|sql|json)|(?<![\w/])README\.md/g;
const SECTION_REF =
  /(?:`?((?:docs\/prd\/)?(?:spec|modules|pages|tickets)\/[^`\s]+\.md|`?[A-Z]\d+[^`\s]*\.md)`?)[\s\u3000]*§(\d+(?:\.\d+)*)/g;
const RANGE_REF = /`([A-Z][A-Z0-9]*)-(\d+)`\s*[–—-]\s*`?([A-Z][A-Z0-9]*)-(\d+)`?/g;
const FILE_ROW = /^\|\s*(.+?)\s*\|\s*([^|]*?)\s*\|/;
const KINDS = new Set(['新建', '修改']);

const findings = [];
const fail = (assertion, where, message) => findings.push({ assertion, where, message });
const rel = (p) => path.relative(REPO, p).split(path.sep).join('/') || '.';
const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** Markdown 表格行 → 单元格（考虑 `\|` 转义；首尾空串去掉）。 */
const tableCells = (line) =>
  line
    .replace(/\\\|/g, '\u0001')
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim().replace(/\u0001/g, '\\|'));

/** 表格行的表头：向上找到最近的 `|---|` 分隔行，取它上面那一行。 */
const tableHeader = (lines, i) => {
  for (let k = i - 1; k >= 0; k -= 1) {
    const l = lines[k];
    if (/^\|[\s:|-]+\|$/.test(l.trim())) return lines[k - 1] ?? '';
    if (!l.startsWith('|')) break;
  }
  return '';
};

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });

// ---------------------------------------------------------------- 读取文档树
if (!fs.existsSync(PRD)) {
  console.error(`check:docs: 找不到文档树：${PRD}`);
  process.exit(2);
}
const allFiles = walk(PRD);
const mdFiles = allFiles.filter((f) => f.endsWith('.md'));
const registryPath = path.join(PRD, 'spec/check-registry.json');
const texts = new Map([...mdFiles, registryPath].map((f) => [f, fs.readFileSync(f, 'utf8')]));
const linesOf = (f) => texts.get(f).split('\n');

if (!fs.existsSync(registryPath)) {
  console.error(`check:docs: 找不到注册表：${rel(registryPath)}`);
  process.exit(2);
}
let registry;
try {
  registry = JSON.parse(texts.get(registryPath));
} catch (err) {
  console.error(`check:docs: 注册表不是合法 JSON：${rel(registryPath)} — ${err.message}`);
  process.exit(2);
}
const checks = registry.checks ?? [];
const retired = registry.retiredIds ?? [];
const byId = new Map();
const ids = new Set(checks.map((c) => c.id));

// 章节字典：文档 → { 顶层节号, "N" → Set("N.M") }
const sections = new Map();
for (const f of mdFiles) {
  const top = new Set();
  const subs = new Map();
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    const h = l.match(/^#{1,6}\s+(\d+)(?:\.(\d+))?[.\s]/);
    if (!h) continue;
    if (h[2] === undefined) top.add(h[1]);
    else {
      if (!subs.has(h[1])) subs.set(h[1], new Set());
      subs.get(h[1]).add(`${h[1]}.${h[2]}`);
    }
  }
  sections.set(path.normalize(f), { top, subs });
}

// ---------------------------------------------------------------- 工单表头
const ticketsDir = path.join(PRD, 'tickets');
const ticketFiles = fs
  .readdirSync(ticketsDir)
  .filter((f) => /^T\d+.*\.md$/.test(f))
  .sort()
  .map((f) => ({ id: f.slice(0, 3), file: path.join(ticketsDir, f) }));

const expandRanges = (line) =>
  line.replace(RANGE_REF, (all, p1, n1, p2, n2) => {
    if (p1 !== p2) return all;
    const out = [];
    for (let i = Number(n1); i <= Number(n2); i += 1) out.push(`\`${p1}-${String(i).padStart(2, '0')}\``);
    return out.join('、');
  });

// ---------------------------------------------------------------- 权威总表
// spec/07-验收标准.md §2 是 ID 的权威定义；注册表是它的机器可读副本，两者不许漂移。
const authorityPath = path.join(PRD, 'spec/07-验收标准.md');
const authority = new Map();
if (fs.existsSync(authorityPath)) {
  let section = '';
  linesOf(authorityPath).forEach((line, i) => {
    const h = line.match(/^### (2\.\d+)/);
    if (h) section = h[1];
    if (!line.startsWith('|')) return;
    const cells = tableCells(line);
    if (cells.length !== 5) return;
    const idm = cells[0].match(/^`([A-Z][A-Z0-9]{1,3}-\d{2})`$/);
    if (!idm) return;
    if (authority.has(idm[1])) {
      fail('ids-unique', `${rel(authorityPath)}:${i + 1}`, `检查项总表里 ID 重复：${idm[1]}（一号两义）`);
    }
    authority.set(idm[1], {
      layer: section === '2.9' ? 'A' : 'B',
      owner: cells[3].replace(/`/g, ''),
      path: cells[4].replace(/`/g, ''),
      line: i + 1,
    });
  });
}
const spec07 = `${rel(authorityPath)}`;

const claims = new Map(); // id → [ticketId]
const headers = new Map(); // ticketId → { raw, ids, regressionOnly, line }
for (const t of ticketFiles) {
  const lines = linesOf(t.file);
  const idx = lines.findIndex((l) => /^\|\s*检查项\s*\|/.test(l));
  if (idx === -1) {
    fail('single-owner', `${rel(t.file)}`, '工单缺少 `| 检查项 | … |` 表头行');
    continue;
  }
  const raw = lines[idx].replace(/^\|\s*检查项\s*\|/, '').replace(/\|\s*$/, '').trim();
  const regressionOnly = /无专属项/.test(raw);
  const found = [];
  for (const m of expandRanges(raw).matchAll(new RegExp(ID_SHAPE.source, 'g'))) {
    if (!found.includes(m[0])) found.push(m[0]);
  }
  headers.set(t.id, { raw, ids: found, regressionOnly, line: idx + 1, file: t.file });
  for (const id of found) {
    if (!ids.has(id)) {
      const gone = retired.find((r) => r.id === id);
      fail(
        'declared-ids-exist',
        `${rel(t.file)}:${idx + 1}`,
        gone ? `工单表头引用了已退役的 ID：${id}（${gone.reason}）` : `工单表头声明了未注册的 ID：${id}`,
      );
    }
  }
  if (regressionOnly) continue;
  for (const id of found) {
    if (!claims.has(id)) claims.set(id, []);
    claims.get(id).push(t.id);
  }
}

// ------------------------------------------------- 断言 1：ID 唯一
for (const c of checks) {
  if (byId.has(c.id)) fail('ids-unique', rel(registryPath), `ID 重复注册：${c.id}`);
  byId.set(c.id, c);
}
for (const r of retired) {
  if (ids.has(r.id)) fail('ids-unique', rel(registryPath), `退役 ID ${r.id} 又出现在注册表里`);
}
for (const c of checks) {
  if (!c.id || !c.layer || !c.owner || !c.path || !c.assertedBy) {
    fail('ids-unique', rel(registryPath), `记录缺字段：${c.id ?? '(无 ID)'}`);
  }
}

// ------------------------------------------------- 断言 2/3：owner 与孤儿
for (const c of checks) {
  const got = [...(claims.get(c.id) ?? [])].sort();
  const declared = [...(c.tickets ?? [])].sort();
  const auth = authority.get(c.id);
  if (!auth) {
    fail('single-owner', rel(registryPath), `${c.id} 不在 ${spec07} §2 的检查项总表里（ID 必须先在那里定义）`);
  } else {
    if (auth.owner !== c.owner) {
      fail(
        'single-owner',
        `${spec07}:${auth.line}`,
        `${c.id} 的 owner 与权威定义不一致：注册表 [${c.owner}] / ${spec07} §2 [${auth.owner}]`,
      );
    }
    if (auth.path !== c.path) {
      fail(
        'single-owner',
        `${spec07}:${auth.line}`,
        `${c.id} 的 path 与权威定义不一致：注册表 [${c.path}] / ${spec07} §2 [${auth.path}]`,
      );
    }
    if (auth.layer !== c.layer) {
      fail(
        'single-owner',
        `${spec07}:${auth.line}`,
        `${c.id} 的 layer 与权威定义不一致：注册表 [${c.layer}] / ${spec07} §2 [${auth.layer}]`,
      );
    }
    const wantAssertedBy = c.layer === 'A' ? 'pnpm test' : 'pnpm check:acceptance';
    if (c.assertedBy !== wantAssertedBy) {
      fail(
        'single-owner',
        rel(registryPath),
        `${c.id} 的 assertedBy 与 layer 不匹配：${c.layer} 层应为 ${wantAssertedBy}，注册表写的是 ${c.assertedBy}`,
      );
    }
  }
  if (got.length === 0) {
    fail('no-orphan', rel(registryPath), `${c.id} 没有任何工单表头认领`);
  } else if (got.length > 1) {
    fail('single-owner', rel(registryPath), `${c.id} 被 ${got.join(' / ')} 同时认领（双 owner）`);
  }
  if (got.join(',') !== declared.join(',')) {
    fail(
      'single-owner',
      rel(registryPath),
      `${c.id} 的 tickets 与工单表头不一致：注册表 [${declared.join(' ')}] / 表头 [${got.join(' ')}]`,
    );
  }
}
for (const [id, owners] of claims) {
  if (!ids.has(id)) fail('declared-ids-exist', rel(registryPath), `${id}（${owners.join('/')} 声明）不在注册表里`);
}

// ------------------------------------------------- 断言 4：文档里的 ID 都已注册
const retiredIds = new Set(retired.map((r) => r.id));
for (const f of mdFiles) {
  linesOf(f).forEach((line, i) => {
    for (const token of BACKTICKED(line)) {
      if (retiredIds.has(token)) {
        const gone = retired.find((r) => r.id === token);
        fail('declared-ids-exist', `${rel(f)}:${i + 1}`, `引用了已退役的 ID：${token}（${gone.reason}）`);
        continue;
      }
      if (!ID_TOKEN.test(token)) continue;
      if (ids.has(token)) continue;
      fail('declared-ids-exist', `${rel(f)}:${i + 1}`, `引用了未注册的 ID：${token}`);
    }
  });
}

// ------------------------------------------------- 断言 5：「新建」唯一
const ROOT_DIRS = /^(app|components|hooks|src|scripts|public|migrations|fixtures|docs|data|storage|lib|tests)\//;
const expandBraces = (p) => {
  const m = p.match(/^(.*)\{([^{}]+)\}(.*)$/);
  if (!m) return [p];
  return m[2].split(',').flatMap((alt) => expandBraces(`${m[1]}${alt}${m[3]}`));
};
const news = new Map(); // path → [ticket]
for (const t of ticketFiles) {
  let inTable = false;
  linesOf(t.file).forEach((line, i) => {
    if (/^##\s/.test(line)) inTable = false;
    if (/^\|\s*路径\s*\|/.test(line)) {
      inTable = true;
      return;
    }
    if (!inTable || !line.startsWith('|')) return;
    const row = line.match(FILE_ROW);
    if (!row) return;
    const kind = row[2];
    if (!KINDS.has(kind) && !/新建|修改/.test(kind)) return;
    const where = `${rel(t.file)}:${i + 1}`;
    if (!KINDS.has(kind)) {
      fail('single-new', where, `「新建/修改」必须二选一：${kind || '(空)'}`);
      return;
    }
    for (const raw of BACKTICKED(row[1]).flatMap(expandBraces)) {
      if (raw.endsWith('/') || raw.includes('*')) continue; // 目录与通配不参与唯一性
      if (!ROOT_DIRS.test(raw) && !ROOT_FILES.has(raw)) {
        fail('single-new', where, `声明路径必须是完整仓库相对路径：${raw}`);
        continue;
      }
      if (kind !== '新建') continue;
      if (!news.has(raw)) news.set(raw, []);
      news.get(raw).push({ ticket: t.id, where });
    }
  });
}
for (const [p, list] of news) {
  if (list.length > 1) {
    fail(
      'single-new',
      list.map((x) => x.where).join(' '),
      `「新建」被重复声明：${p} ← ${list.map((x) => x.ticket).join(' / ')}`,
    );
  }
}
// 已声明「新建」的产物在落地前不存在是正常的，不算破损引用（断言 6 用）
const declaredNew = new Set(news.keys());

// ------------------------------------------------- 断言 6：被引用的文件/章节/归属文档
const resolveDocRef = (from, ref) => {
  const clean = ref.replace(/^`|`$/g, '');
  const candidates = [];
  if (clean.startsWith('docs/')) candidates.push(path.join(REPO, clean));
  candidates.push(path.join(PRD, clean));
  candidates.push(path.join(path.dirname(from), clean));
  return candidates.find((c) => fs.existsSync(c)) ?? null;
};
for (const f of mdFiles) {
  linesOf(f).forEach((line, i) => {
    const where = `${rel(f)}:${i + 1}`;
    const seen = new Set();
    for (const m of line.matchAll(DOC_REF)) {
      const ref = m[0];
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (resolveDocRef(f, ref)) continue;
      if (declaredNew.has(ref)) continue; // 已被某条工单声明「新建」，落地前不存在是正常的
      fail('refs-resolve', where, `指向不存在的文件：${ref}（也没有工单把它声明为「新建」）`);
    }
    for (const m of line.matchAll(SECTION_REF)) {
      const [, ref, sec] = m;
      const target = resolveDocRef(f, ref);
      if (!target) continue; // 文件本身不存在已由上面报出
      const info = sections.get(path.normalize(target));
      if (!info) continue;
      const [parent, sub] = sec.split('.');
      if (sub === undefined) {
        if (!info.top.has(parent)) fail('refs-resolve', where, `指向不存在的章节：${ref} §${sec}`);
        continue;
      }
      if (!info.subs.has(parent)) continue; // §N.M 可能指「第 N 节第 M 条」，无法判定
      if (!info.subs.get(parent).has(sec)) {
        fail('refs-resolve', where, `指向不存在的章节：${ref} §${sec}`);
      }
    }
  });
}
for (const c of checks) {
  if (c.owner && !fs.existsSync(path.join(PRD, c.owner))) {
    fail('refs-resolve', rel(registryPath), `${c.id} 的 owner 不存在：${c.owner}`);
  }
}

// ------------------------------------------------- 断言 7：索引列 ≡ 工单表头
const readmePath = path.join(ticketsDir, 'README.md');
let readme = fs.readFileSync(readmePath, 'utf8');
const indexRow = (text, id) => {
  const re = new RegExp(`^\\|\\s*\`${id}\`\\s*\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|\\s*$`, 'm');
  const m = text.match(re);
  return m ? m[5].trim() : null;
};
const rowLine = (text, id) => {
  const re = new RegExp(`^\\|\\s*\`${id}\`\\s*\\|.*$`, 'm');
  const m = text.match(re);
  return m ? m[0] : null;
};
const rebuilt = new Map();
for (const t of ticketFiles) {
  const head = headers.get(t.id);
  if (!head) continue;
  rebuilt.set(t.id, head.raw);
  const got = indexRow(readme, t.id);
  if (got === null) {
    fail('index-matches-headers', rel(readmePath), `索引里没有 ${t.id} 这一行`);
    continue;
  }
  if (norm(got) !== norm(head.raw)) {
    if (!WRITE_INDEX) {
      fail(
        'index-matches-headers',
        `${rel(readmePath)} (${t.id})`,
        `与工单表头不一致：索引 [${norm(got)}] / 表头 [${norm(head.raw)}]`,
      );
    }
  }
}
if (WRITE_INDEX) {
  let next = readme;
  let rewrote = 0;
  for (const [id, raw] of rebuilt) {
    const line = rowLine(next, id);
    if (!line) continue;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (cells[cells.length - 1] === raw) continue;
    cells[cells.length - 1] = raw;
    next = next.replace(line, `| ${cells.join(' | ')} |`);
    rewrote += 1;
  }
  if (next !== readme) {
    fs.writeFileSync(readmePath, next);
    console.log(`check:docs: 已按工单表头重写 ${rel(readmePath)} 的检查项列（${rewrote} 行）`);
  }
}

// ------------------------------------------------- 断言 8：计数 ≡ 注册表派生值
const derived = {
  B: checks.filter((c) => c.layer === 'B').length,
  A: checks.filter((c) => c.layer === 'A').length,
  total: checks.length,
  files: allFiles.length,
};
const COUNT_PATTERNS = [
  [/B 层（(\d+) 项）/, 'B'],
  [/B 层全部 (\d+) 项/, 'B'],
  [/B 层 (\d+) 项/, 'B'],
  [/A 层（(\d+) 项）/, 'A'],
  [/A 层 (\d+) 项/, 'A'],
  [/总计 (\d+) 项/, 'total'],
  [/共 (\d+) 项是 A 层/, 'A'],
  [/全部 (\d+) 项/, 'B'],
  [/(\d+) 项全绿/, 'B'],
  [/(\d+) passed, 0 failed/, 'B'],
  [/共 \*?\*?(\d+) 个文件/, 'files'],
];
for (const f of [...mdFiles, registryPath]) {
  linesOf(f).forEach((line, i) => {
    for (const [re, key] of COUNT_PATTERNS) {
      for (const m of line.matchAll(new RegExp(re.source, 'g'))) {
        if (Number(m[1]) === derived[key]) continue;
        fail(
          'counts-match-registry',
          `${rel(f)}:${i + 1}`,
          `计数与注册表不符：写的是 ${m[1]}（${key}），注册表派生出 ${derived[key]}`,
        );
      }
    }
  });
}

// ------------------------------------------------- 断言 9/10/11：契约单点化
// 断言 9：错误码表只存在于 spec/03 §5
// 判定两件事：(a) 首列是错误码的表格，不得再有「HTTP / 状态」列或「文案」列；
// (b) 任何单元格的值不得是「错误码 + 它自己的状态码」（`401 UNAUTHENTICATED`、`CODE / 409`）。
// 表格行里的正常叙述（如验收项「→ `409 ANCHOR_NOT_CONFIRMED`」）不算复述。
const errorCodesPath = path.join(PRD, 'spec/03-接口契约.md');
const codeStatus = new Map();
if (fs.existsSync(errorCodesPath)) {
  for (const line of linesOf(errorCodesPath)) {
    const cells = tableCells(line);
    if (cells.length < 2) continue;
    const code = cells[0].replace(/`/g, '');
    if (/^[A-Z][A-Z0-9_]{3,}$/.test(code) && /^\d{3}$/.test(cells[1])) codeStatus.set(code, Number(cells[1]));
  }
}
if (fs.existsSync(errorCodesPath) && codeStatus.size === 0) {
  fail('error-single-source', rel(errorCodesPath), '解析不出错误码表（列序变了？）——本断言会退化成空转，先修这里');
}
const CELL_IS_CODE_WITH_STATUS = (cell) => {
  const raw = cell.replace(/`/g, '').trim();
  for (const [code, status] of codeStatus) {
    if (!raw.includes(code)) continue;
    const rest = raw.replace(code, '').replace(/[\s/、,（()）]+/g, '');
    if (rest === '') return null; // 只写码、没写状态码，不算复述
    if (rest === String(status)) return { code, status };
  }
  return null;
};
for (const f of mdFiles) {
  if (path.normalize(f) === path.normalize(errorCodesPath)) continue;
  const lines = linesOf(f);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const cells = tableCells(line);
    const where = `${rel(f)}:${i + 1}`;
    // (b) 单元格 = 码 + 状态码
    for (const cell of cells) {
      const hit = CELL_IS_CODE_WITH_STATUS(cell);
      if (hit) {
        fail(
          'error-single-source',
          where,
          `单元格里复述了 HTTP 状态码（${hit.code} → ${hit.status}）：只能引用 spec/03-接口契约.md §5`,
        );
      }
    }
    // (a) 首列是错误码的表：不得有状态码列或文案列
    const code = cells[0]?.replace(/`/g, '');
    if (code === undefined || !codeStatus.has(code)) continue;
    const header = tableHeader(lines, i);
    if (/文案/.test(header)) {
      fail('error-single-source', where, `错误码表里复述了用户文案列（${code}）：只能引用 spec/03-接口契约.md §5`);
    }
    if (/HTTP|状态码/.test(header)) {
      fail('error-single-source', where, `错误码表里复述了 HTTP 状态列（${code}）：只能引用 spec/03-接口契约.md §5`);
    }
  }
}
// 断言 10：prompt 长度区间只在 spec/07 声明一次
const THRESHOLD_RE = /\[\s*200\s*,\s*1200\s*\]|200\s*[–—-]\s*1200|300\s*[–—-]\s*900|低于\s*200|高于\s*1200/;
const spec07Path = path.join(PRD, 'spec/07-验收标准.md');
for (const f of mdFiles) {
  if (path.normalize(f) === path.normalize(spec07Path)) continue;
  linesOf(f).forEach((line, i) => {
    if (!THRESHOLD_RE.test(line)) return;
    if (!/长度|字符|字\b/.test(line)) return;
    fail(
      'threshold-single-source',
      `${rel(f)}:${i + 1}`,
      '在此处复述了 prompt 长度区间：唯一阈值声明在 spec/07-验收标准.md 的 `PR-07`',
    );
  });
}

// 断言 11：任务来源「几张表」只有一个说法
// 跳过「与上游文档的差异」类章节——那里会照引上游说法（含被本仓库否定的「两张任务表」）。
for (const f of mdFiles) {
  let section = '';
  linesOf(f).forEach((line, i) => {
    const heading = line.match(/^#{2,3}\s+(.*)$/);
    if (heading) {
      section = heading[1];
      return;
    }
    if (/差异|上游/.test(section)) return;
    if (!/任务来源|任务表/.test(line)) return;
    // 「下一张表 / 上一张表」是「邻接的那张表」，不是张数声明，先摘掉再数
    const stripped = line.replace(/[上下]一张表/g, '');
    for (const m of stripped.matchAll(/([0-9一二两三四])\s*张(?:任务)?表/g)) {
      if (m[1] === '三' || m[1] === '3') continue;
      fail(
        'task-source-single-count',
        `${rel(f)}:${i + 1}`,
        `任务来源必须说「三张表」（identity_anchors / prompt_reverse_jobs / generations），这里写的是「${m[0]}」`,
      );
    }
  });
}

// ---------------------------------------------------------------- 输出
if (findings.length) {
  for (const f of findings) console.error(`[${f.assertion}] ${f.where} — ${f.message}`);
  console.error(
    `check:docs FAILED: ${findings.length} 处不一致（注册表 ${derived.total} 项：B ${derived.B} / A ${derived.A}）`,
  );
  process.exit(1);
}
console.log(
  `check:docs OK: 11 条断言全绿（注册表 ${derived.total} 项：B ${derived.B} / A ${derived.A}；文档 ${derived.files} 份）`,
);
