import fs from 'node:fs';
import path from 'node:path';

const PRD = 'docs/prd';
const ID_RE = /\b((?:DB|PR|API|E2E|SEC|DEL|ERR|CMP|PRE|MARK|REV|RN)-\d+)\b/g;
const A_PREFIX = new Set(['PRE', 'MARK']);

// 把 `X-01`–`X-09` 这类区间展开成逐项，避免表头用区间写时统计漏项
const RANGE_RE = /`([A-Z][A-Z0-9]*)-(\d+)`\s*[–—-]\s*`([A-Z][A-Z0-9]*)-(\d+)`/g;
function expandRanges(line) {
  return line.replace(RANGE_RE, (all, p1, n1, p2, n2) => {
    if (p1 !== p2) return all;
    const a = Number(n1);
    const b = Number(n2);
    const out = [];
    for (let i = a; i <= b; i += 1) out.push(`\`${p1}-${String(i).padStart(2, '0')}\``);
    return out.join('、');
  });
}

// 表头里声明"本 ticket 无专属项"的那段只算回归，不计入 owner
const isRegressionOnly = (line) => /无专属项/.test(line);

const layer = (id) => (A_PREFIX.has(id.split('-')[0]) ? 'A' : 'B');

const s7 = fs.readFileSync(path.join(PRD, 'spec/07-验收标准.md'), 'utf8');
const ids = [...new Set([...s7.matchAll(ID_RE)].map((m) => m[1]))].sort();
const reg = new Map(ids.map((i) => [i, { layer: layer(i), owners: [] }]));

const tdir = path.join(PRD, 'tickets');
const tks = fs.readdirSync(tdir).filter((f) => /^T\d+.*\.md$/.test(f)).sort();
const phantom = [];
for (const f of tks) {
  const t = fs.readFileSync(path.join(tdir, f), 'utf8');
  const rawLine = (t.match(/^\| 检查项 \|.*$/m) || [''])[0];
  const line = expandRanges(rawLine);
  const regressionOnly = isRegressionOnly(rawLine);
  const seen = new Set();
  for (const m of line.matchAll(ID_RE)) {
    const id = m[1];
    if (!reg.has(id)) { phantom.push(`${id} (${f.slice(0, 3)})`); continue; }
    if (regressionOnly) continue;
    if (!seen.has(id)) { reg.get(id).owners.push(f.slice(0, 3)); seen.add(id); }
  }
}

const unowned = [...reg].filter(([, v]) => v.owners.length === 0).map(([k]) => k);
const dup = [...reg].filter(([, v]) => v.owners.length > 1).map(([k, v]) => `${k}→${v.owners.join(',')}`);
const B = ids.filter((i) => layer(i) === 'B').length;
const A = ids.filter((i) => layer(i) === 'A').length;

// 检查项总数 vs spec/07 声明的口径
const counts = {};
for (const id of ids) {
  const p = id.split('-')[0];
  counts[p] = (counts[p] || 0) + 1;
}
console.log('registry:', ids.length, '| B:', B, '| A:', A);
console.log('by family:', Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' '));
console.log('UNOWNED (' + unowned.length + '):', unowned.join(' ') || '(none)');
console.log('DOUBLE-OWNED (' + dup.length + '):', dup.join('  ') || '(none)');
console.log('PHANTOM (' + phantom.length + '):', phantom.join(' ') || '(none)');

// 全库残留扫描
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const stale = [];
for (const f of walk(PRD)) {
  if (!/\.(md|json|sql)$/.test(f)) continue;
  const txt = fs.readFileSync(f, 'utf8');
  txt.split('\n').forEach((l, i) => {
    if (/\bU14\b/.test(l)) stale.push(`${f}:${i + 1} U14`);
    if (/82 (项|passed)/.test(l)) stale.push(`${f}:${i + 1} 82项`);
    if (/从 `docs\/output\/` 拷|6 张真实样片/.test(l)) stale.push(`${f}:${i + 1} 样片拷贝`);
    if (/写作 `GET`|写作 `GET`，实际端点/.test(l)) stale.push(`${f}:${i + 1} SEC-07陈旧`);
    if (/SQLite \*\*单进程\*\*|db\.transaction\.exclusive/.test(l)) stale.push(`${f}:${i + 1} 单进程/exclusive`);
  });
}
console.log('STALE (' + stale.length + '):');
for (const s of stale) console.log('  ' + s);
