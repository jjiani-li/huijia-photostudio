/**
 * check-docs 的回归网。
 *
 * 断言的都是**外部可观察的事实**：夹具文档树上跑一次闸门，看退出码与诊断输出
 * （哪条断言、哪条 ID、哪份文件、哪一行）。不断言脚本内部的实现细节（正则、函数名）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(HERE, 'check-docs.mjs');

const CHECKS = [
  {
    id: 'DB-01',
    layer: 'B',
    owner: 'spec/07-验收标准.md',
    path: '[mock]',
    assertedBy: 'pnpm check:acceptance',
    tickets: ['T01'],
  },
];

const registry = (checks = CHECKS, extra = {}) => ({
  version: 'v1',
  description: '夹具注册表',
  retiredIds: [{ id: 'U14', reason: '上游残留 ID' }],
  checks,
  ...extra,
});

const ticket = ({ header = '`DB-01`', rows = ['| `src/a.ts` | 新建 | 模块 a | `spec/07-验收标准.md` |'], extra = '' } = {}) =>
  [
    '# T01 · 夹具工单',
    '',
    '| 项 | 值 |',
    '|---|---|',
    '| 阶段 | M1 |',
    `| 检查项 | ${header} |`,
    '',
    '## 3. 要交付的文件',
    '| 路径 | 新建/修改 | 职责 | 依据 |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## Comments',
    extra,
    '',
  ].join('\n');

const readme = (cell = '`DB-01`') =>
  [
    '# Ticket 总表',
    '',
    '| # | 标题 | 阶段 | 依赖 | 必读文档 | 检查项 |',
    '|---|---|---|---|---|---|',
    `| \`T01\` | 夹具工单 | M1 | — | \`spec/07-验收标准.md\` | ${cell} |`,
    '',
  ].join('\n');

const AUTH_ROW = '| `DB-01` | 夹具检查 | 通过 | `spec/07-验收标准.md` | `[mock]` |';
const spec07 = (body = '', row = AUTH_ROW) =>
  [
    '# 07 · 验收标准',
    '',
    '## 2. 检查项总表',
    '### 2.1 结构与数据',
    '| ID | 检查 | 判定 | 归属 | 路径 |',
    '|---|---|---|---|---|',
    row,
    '',
    '## 5. 分节',
    '### 5.1 子节',
    '',
    body,
    '',
  ].join('\n');

/** 建一棵最小可绿夹具树；overrides 用来注入待测缺陷 */
function tree(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-docs-'));
  const prd = path.join(root, 'docs/prd');
  const write = (rel, content) => {
    const full = path.join(prd, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('README.md', '# 夹具索引\n');
  write('spec/07-验收标准.md', spec07());
  write('spec/check-registry.json', JSON.stringify(registry(), null, 2) + '\n');
  write('tickets/T01-夹具工单.md', ticket());
  write('tickets/README.md', readme());
  for (const [rel, content] of Object.entries(overrides)) write(rel, content);
  return prd;
}

function run(prd, args = []) {
  const res = spawnSync(process.execPath, [SCRIPT, '--root', prd, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const expectFinding = (result, { assertion, needles, code = 1 }) => {
  assert.equal(result.code, code, `退出码应为 ${code}，实际 ${result.code}\n${result.out}`);
  assert.match(result.out, new RegExp(`\\[${assertion}\\]`), `缺少断言 ${assertion} 的诊断\n${result.out}`);
  for (const n of needles) assert.ok(result.out.includes(n), `诊断里应指出 ${n}\n${result.out}`);
};

// --------------------------------------------------------------- 绿基线
test('最小夹具树跑出全绿，退出码 0', () => {
  const prd = tree();
  const res = run(prd);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /check:docs OK/);
});

test('真实文档树全绿', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8' });
  const out = `${res.stdout}${res.stderr}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /check:docs OK/);
});

// --------------------------------------------------------------- 1/2/3 ID 与 owner
test('ID 重复注册被拦下', () => {
  const prd = tree({ 'spec/check-registry.json': JSON.stringify(registry([...CHECKS, CHECKS[0]]), null, 2) });
  expectFinding(run(prd), { assertion: 'ids-unique', needles: ['DB-01'] });
});

test('双 owner（两条工单认领同一 ID）被拦下', () => {
  const prd = tree({ 'tickets/T02-夹具工单.md': ticket() });
  const res = run(prd);
  expectFinding(res, { assertion: 'single-owner', needles: ['DB-01', 'T01', 'T02'] });
});

test('注册表里的 tickets 与工单表头不一致被拦下', () => {
  const prd = tree({
    'spec/check-registry.json': JSON.stringify(registry([{ ...CHECKS[0], tickets: ['T09'] }]), null, 2),
  });
  expectFinding(run(prd), { assertion: 'single-owner', needles: ['DB-01', 'T01', 'T09'] });
});

test('无孤儿：没有任何工单认领的 ID 被拦下', () => {
  const prd = tree({
    'spec/check-registry.json': JSON.stringify(registry([{ ...CHECKS[0], tickets: [] }]), null, 2),
    'tickets/T01-夹具工单.md': ticket({ header: '—' }),
  });
  expectFinding(run(prd), { assertion: 'no-orphan', needles: ['DB-01'] });
});

test('注册表与权威总表（spec/07 §2）漂移被拦下', () => {
  const prd = tree({
    'spec/check-registry.json': JSON.stringify(registry([{ ...CHECKS[0], owner: 'modules/M99-别处.md' }]), null, 2),
  });
  const res = run(prd);
  expectFinding(res, { assertion: 'single-owner', needles: ['DB-01', 'modules/M99-别处.md'] });
});

test('注册表 A/B 层级与权威总表不一致被拦下', () => {
  const prd = tree({
    'spec/check-registry.json': JSON.stringify(registry([{ ...CHECKS[0], layer: 'A' }]), null, 2),
  });
  expectFinding(run(prd), { assertion: 'single-owner', needles: ['DB-01', 'layer'] });
});

test('权威总表里 ID 重复（一号两义）被拦下', () => {
  const prd = tree({ 'spec/07-验收标准.md': spec07('', `${AUTH_ROW}\n${AUTH_ROW}`) });
  expectFinding(run(prd), { assertion: 'ids-unique', needles: ['DB-01', '07-验收标准.md'] });
});

test('注册表里有权威总表没有的 ID 被拦下', () => {
  const prd = tree({
    'spec/check-registry.json': JSON.stringify(
      registry([...CHECKS, { ...CHECKS[0], id: 'ZZ-77', tickets: ['T01'] }]),
      null,
      2,
    ),
  });
  expectFinding(run(prd), { assertion: 'single-owner', needles: ['ZZ-77', '检查项总表'] });
});

// --------------------------------------------------------------- 4 声明的 ID
test('工单表头声明未注册的 ID 被拦下', () => {
  const prd = tree({ 'tickets/T01-夹具工单.md': ticket({ header: '`DB-01`、`QQ-99`' }) });
  expectFinding(run(prd), { assertion: 'declared-ids-exist', needles: ['QQ-99', 'T01-夹具工单.md'] });
});

test('已退役的 ID 再次出现被拦下', () => {
  const prd = tree({ 'tickets/T01-夹具工单.md': ticket({ extra: '- 旧账：`U14` 不存在了。' }) });
  expectFinding(run(prd), { assertion: 'declared-ids-exist', needles: ['U14'] });
});

test('文档里引用未注册的 ID 被拦下', () => {
  const prd = tree({ 'spec/07-验收标准.md': spec07('见 `ZZ-42`。') });
  expectFinding(run(prd), { assertion: 'declared-ids-exist', needles: ['ZZ-42', '07-验收标准.md:'] });
});

// --------------------------------------------------------------- 5 新建唯一
test('同一文件被两条工单声明「新建」被拦下', () => {
  const prd = tree({ 'tickets/T02-夹具工单.md': ticket({ header: '—' }) });
  expectFinding(run(prd), { assertion: 'single-new', needles: ['src/a.ts', 'T01', 'T02'] });
});

test('声明路径必须完整（缩写片段被拦下）', () => {
  const prd = tree({ 'tickets/T01-夹具工单.md': ticket({ rows: ['| `src/a.ts`、`b.ts` | 新建 | 模块 a | `spec/07-验收标准.md` |'] }) });
  expectFinding(run(prd), { assertion: 'single-new', needles: ['b.ts'] });
});

test('「新建/修改」未二选一被拦下', () => {
  const prd = tree({ 'tickets/T01-夹具工单.md': ticket({ rows: ['| `src/a.ts` | 新建/修改 | 模块 a | `spec/07-验收标准.md` |'] }) });
  expectFinding(run(prd), { assertion: 'single-new', needles: ['新建/修改'] });
});

// --------------------------------------------------------------- 6 引用
test('指向不存在的文件被拦下', () => {
  const prd = tree({ 'tickets/T01-夹具工单.md': ticket({ extra: '- 见 `pages/P09-不存在.md`。' }) });
  expectFinding(run(prd), { assertion: 'refs-resolve', needles: ['pages/P09-不存在.md'] });
});

test('已声明「新建」但尚未落地的文档不算破损引用', () => {
  const prd = tree({
    'tickets/T01-夹具工单.md': ticket({
      rows: [
        '| `src/a.ts` | 新建 | 模块 a | `spec/07-验收标准.md` |',
        '| `docs/prd/pages/P09-新页.md` | 新建 | 尚未落地的页面文档 | `spec/07-验收标准.md` |',
      ],
      extra: '- 该页文档见 `docs/prd/pages/P09-新页.md`。',
    }),
  });
  const res = run(prd);
  assert.equal(res.code, 0, res.out);
  assert.doesNotMatch(res.out, /refs-resolve/);
});

test('指向不存在的章节被拦下（目标节有编号子节时）', () => {
  const prd = tree({ 'tickets/T01-夹具工单.md': ticket({ extra: '- 见 `spec/07-验收标准.md` §5.9。' }) });
  expectFinding(run(prd), { assertion: 'refs-resolve', needles: ['spec/07-验收标准.md §5.9'] });
});

test('注册表 owner 指向不存在的文档被拦下', () => {
  const prd = tree({
    'spec/check-registry.json': JSON.stringify(registry([{ ...CHECKS[0], owner: 'modules/M99-不存在.md' }]), null, 2),
  });
  expectFinding(run(prd), { assertion: 'refs-resolve', needles: ['DB-01', 'M99-不存在.md'] });
});

// --------------------------------------------------------------- 7 索引
test('索引列与工单表头漂移被拦下', () => {
  const prd = tree({ 'tickets/README.md': readme('`DB-09`') });
  expectFinding(run(prd), { assertion: 'index-matches-headers', needles: ['DB-09', 'DB-01'] });
});

test('--write-index 按表头重写索引列后转绿', () => {
  const prd = tree({ 'tickets/README.md': readme('`DB-09`') });
  const fixed = run(prd, ['--write-index']);
  assert.ok(fixed.out.includes('已按工单表头重写'), fixed.out);
  const res = run(prd);
  assert.equal(res.code, 0, res.out);
});

// --------------------------------------------------------------- 8 计数
test('文档写出的计数与注册表不符被拦下', () => {
  const prd = tree({ 'spec/07-验收标准.md': spec07('B 层（64 项）') });
  expectFinding(run(prd), { assertion: 'counts-match-registry', needles: ['64', '07-验收标准.md:'] });
});

test('文档树文件数与实际不符被拦下', () => {
  const prd = tree({ 'README.md': '# 夹具索引\n\n本目录共 **99 个文件**。\n' });
  expectFinding(run(prd), { assertion: 'counts-match-registry', needles: ['99'] });
});

// --------------------------------------------------------------- 9/10/11 单点化
test('模块文档里复述错误码表（带用户文案列）被拦下', () => {
  const prd = tree({
    'modules/M99-夹具模块.md': [
      '# M99 · 夹具模块',
      '',
      '| 错误码 | 触发条件 | 用户可见文案 |',
      '|---|---|---|',
      '| `UNAUTHENTICATED` | 未登录 | `请先登录` |',
      '',
    ].join('\n'),
    'spec/03-接口契约.md': [
      '# 03 · 接口契约',
      '',
      '## 5. 错误码总表',
      '',
      '```ts',
      "export type EraCheckVerdict = 'pass' | 'review' | 'reject';",
      "export type ModerationVerdict = 'pass' | 'review' | 'reject';",
      '```',
      '',
      '| code | HTTP | 触发场景 | 用户可见文案（示例） |',
      '|---|---|---|---|',
      '| `UNAUTHENTICATED` | 401 | 未登录 | 请先登录 |',
      '',
    ].join('\n'),
  });
  expectFinding(run(prd), { assertion: 'error-single-source', needles: ['UNAUTHENTICATED'] });
});

test('模块文档里复述错误码表（带 HTTP 状态码）被拦下', () => {
  const prd = tree({
    'modules/M99-夹具模块.md': [
      '# M99 · 夹具模块',
      '',
      '| 错误码 | 触发条件 | HTTP |',
      '|---|---|---|',
      '| `UNAUTHENTICATED` | 未登录 | 401 |',
      '',
    ].join('\n'),
    'spec/03-接口契约.md': [
      '# 03 · 接口契约',
      '',
      '## 5. 错误码总表',
      '',
      '```ts',
      "export type EraCheckVerdict = 'pass' | 'review' | 'reject';",
      "export type ModerationVerdict = 'pass' | 'review' | 'reject';",
      '```',
      '',
      '| code | HTTP | 触发场景 | 用户可见文案（示例） |',
      '|---|---|---|---|',
      '| `UNAUTHENTICATED` | 401 | 未登录 | 请先登录 |',
      '',
    ].join('\n'),
  });
  expectFinding(run(prd), { assertion: 'error-single-source', needles: ['UNAUTHENTICATED', 'HTTP'] });
});

test('只留触发条件的错误码表通过（唯一事实源在 spec/03 §5）', () => {
  const prd = tree({
    'modules/M99-夹具模块.md': [
      '# M99 · 夹具模块',
      '',
      '码与文案的唯一事实源是 `spec/03-接口契约.md` §5。',
      '',
      '| 错误码 | 触发条件 |',
      '|---|---|',
      '| `UNAUTHENTICATED` | 未登录 |',
      '',
    ].join('\n'),
    'spec/03-接口契约.md': [
      '# 03 · 接口契约',
      '',
      '## 5. 错误码总表',
      '',
      '```ts',
      "export type EraCheckVerdict = 'pass' | 'review' | 'reject';",
      "export type ModerationVerdict = 'pass' | 'review' | 'reject';",
      '```',
      '',
      '| code | HTTP | 触发场景 | 用户可见文案（示例） |',
      '|---|---|---|---|',
      '| `UNAUTHENTICATED` | 401 | 未登录 | 请先登录 |',
      '',
    ].join('\n'),
  });
  const res = run(prd);
  assert.equal(res.code, 0, res.out);
});

test('单元格里把状态码与错误码粘在一起被拦下', () => {
  const prd = tree({
    'modules/M99-夹具模块.md': [
      '# M99 · 夹具模块',
      '',
      '| 场景 | 错误码 |',
      '|---|---|',
      '| 未登录 | `401 UNAUTHENTICATED` |',
      '',
    ].join('\n'),
    'spec/03-接口契约.md': [
      '# 03 · 接口契约',
      '',
      '## 5. 错误码总表',
      '',
      '```ts',
      "export type EraCheckVerdict = 'pass' | 'review' | 'reject';",
      "export type ModerationVerdict = 'pass' | 'review' | 'reject';",
      '```',
      '',
      '| code | HTTP | 触发场景 | 用户可见文案（示例） |',
      '|---|---|---|---|',
      '| `UNAUTHENTICATED` | 401 | 未登录 | 请先登录 |',
      '',
    ].join('\n'),
  });
  expectFinding(run(prd), { assertion: 'error-single-source', needles: ['401', 'UNAUTHENTICATED'] });
});

test('验收项叙述里的「→ 409 CODE」不算复述', () => {
  const prd = tree({
    'spec/07-验收标准.md': spec07(''),
    'modules/M99-夹具模块.md': [
      '# M99 · 夹具模块',
      '',
      '| 检查 | 判定 |',
      '|---|---|',
      '| 未确认的锚点发起生成 → `409 ANCHOR_NOT_CONFIRMED` | 通过 |',
      '',
    ].join('\n'),
    'spec/03-接口契约.md': [
      '# 03 · 接口契约',
      '',
      '## 5. 错误码总表',
      '',
      '```ts',
      "export type EraCheckVerdict = 'pass' | 'review' | 'reject';",
      "export type ModerationVerdict = 'pass' | 'review' | 'reject';",
      '```',
      '',
      '| code | HTTP | 触发场景 | 用户可见文案（示例） |',
      '|---|---|---|---|',
      '| `ANCHOR_NOT_CONFIRMED` | 409 | 未确认 | 需要先确认"这就是他" |',
      '',
    ].join('\n'),
  });
  const res = run(prd);
  assert.equal(res.code, 0, res.out);
});

test('在别处复述 prompt 长度区间被拦下', () => {
  const prd = tree({ 'modules/M99-夹具模块.md': '# M99 · 夹具模块\n\nprompt 长度 ∈ [200, 1200] 字符。\n' });
  expectFinding(run(prd), { assertion: 'threshold-single-source', needles: ['M99-夹具模块.md'] });
});

test('prompt 长度区间写在 spec/07 里通过', () => {
  const prd = tree({
    'spec/07-验收标准.md': spec07('prompt 长度 ∈ [200, 1200] 字符（本文件是唯一阈值声明处）'),
  });
  const res = run(prd);
  assert.equal(res.code, 0, res.out);
});

test('任务来源说成非「三张表」被拦下', () => {
  const prd = tree({ 'modules/M99-夹具模块.md': '# M99 · 夹具模块\n\n任务来源是两张任务表。\n' });
  expectFinding(run(prd), { assertion: 'task-source-single-count', needles: ['两张任务表'] });
});

test('「与上游文档的差异」章节里引述上游张数不算复述', () => {
  const prd = tree({
    'modules/M99-夹具模块.md': [
      '# M99 · 夹具模块',
      '',
      '## 10. 与上游文档的差异',
      '',
      '| 上游（`docs/raw/AIGC_PRD.md`） | 本方案 |',
      '|---|---|',
      '| 上游把修复与生成拆成两张任务表 | 异步任务表共三张 |',
      '',
    ].join('\n'),
  });
  const res = run(prd);
  assert.equal(res.code, 0, res.out);
});

// --------------------------------------------------------------- 12 旧词
test('裸写旧词（面部特征锚点 / 场景代号 / 旧长度区间）被拦下', () => {
  for (const [text, needle] of [
    ['本产品提取**面部特征锚点**。', '面部特征锚点'],
    ['`suggestSceneId` 是场景代号。', '场景代号'],
    ['长度 ∈ [40, 200]。', '[40, 200]'],
    ['窗口 `40 ≤ anchor.length ≤ 200`。', '40 ≤ anchor.length ≤ 200'],
  ]) {
    const prd = tree({ 'modules/M99-夹具模块.md': `# M99 · 夹具模块\n\n${text}\n` });
    expectFinding(run(prd), { assertion: 'retired-terms', needles: [needle] });
  }
});

test('两个判定没有各自的名字被拦下', () => {
  const prd = tree({
    'spec/03-接口契约.md': ['# 03 · 接口契约', '', '## 4. 形状', '', '```ts', "export interface EraCheck { passed: boolean; verdict: 'pass' | 'review' | 'reject'; }", '```', ''].join('\n'),
    'modules/M07-生成后复核与内容审核.md': '# M07 · 生成后复核与内容审核\n\n复核判 `reject` 只标注；审核判 `reject` 终止产出。\n',
  });
  expectFinding(run(prd), { assertion: 'retired-terms', needles: ['EraCheckVerdict'] });
});

test('两个判定各自有名则通过', () => {
  const prd = tree({
    'spec/03-接口契约.md': [
      '# 03 · 接口契约',
      '',
      "export type EraCheckVerdict = 'pass' | 'review' | 'reject';",
      "export type ModerationVerdict = 'pass' | 'review' | 'reject';",
      '',
      '## 5. 错误码总表',
      '',
      '| code | HTTP | 触发场景 | 用户可见文案（示例） |',
      '|---|---|---|---|',
      '| `UNAUTHENTICATED` | 401 | 未登录 | 请先登录 |',
      '',
    ].join('\n'),
    'modules/M07-生成后复核与内容审核.md':
      '# M07 · 生成后复核与内容审核\n\n年代复核判定（`eraCheckVerdict`）只标注；内容审核判定（`moderationVerdict`）终止产出。\n',
  });
  const res = run(prd);
  assert.equal(res.code, 0, res.out);
});

// --------------------------------------------------------------- 独立运行
test('不需要环境变量、不依赖产品进程', () => {
  const prd = tree();
  const res = spawnSync(process.execPath, [SCRIPT, '--root', prd], {
    cwd: REPO,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
});
