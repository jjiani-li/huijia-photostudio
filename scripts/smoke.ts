/**
 * `pnpm smoke` —— `E2E-01` 端到端冒烟的执行器（`docs/prd/tickets/T20-验收：自动化检查与端到端冒烟.md` §3–§4、
 * `docs/prd/spec/08-本地开发指南.md` §7）。
 *
 * 用 `docs/老照片/` 里的真实样例走完整链路：登入 → 上传 → preprocess → 建锚点 → 轮询至 succeeded →
 * confirm → 生成 E4×S3 count=2 → 轮询至 succeeded（2 张）→ 历史可见 → 下载结果图（`sharp` 解析出宽高）。
 * 与 `scripts/acceptance.ts` 相同，**全程进程内直调 Next route handler**（不起 HTTP 服务、不需要 `pnpm dev`）。
 *
 * 默认 `PROVIDER=mock`；`pnpm smoke -- --real` 强制 `PROVIDER=real`（人工看图用，`ARK_API_KEY` 取自环境变量）。
 * 前置：`pnpm migrate && pnpm seed` 已跑、`pnpm worker` 已在另一终端启动——脚本先探测 `GET /api/health`，
 * `db.ok=false`（未迁移 / 未种子）或 `worker.alive=false`（心跳缺失 / 过期）即**直接失败并提示**
 * （`docs/prd/spec/08-本地开发指南.md` §3.1）。
 *
 * 自带清理：一次运行内记录的 `photos` / `identity_anchors` / `generations` id 列表驱动，`finally` 里删行、
 * 删盘上文件、还原额度计数（`docs/prd/spec/07-验收标准.md` §3）；全通过退出码 0，任一失败退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { NextRequest } from 'next/server';
import { getDb } from '../src/server/db/connection';
import { hardDeleteAnchor } from '../src/server/db/repositories/anchors';
import { findById as findGenerationById } from '../src/server/db/repositories/generations';
import { getStorage } from '../src/server/storage';
import { dayKey } from '../src/server/domain/time';
import { historyListSchema } from '../src/shared/types';
import { SID_COOKIE, createSession, hashToken } from '../src/server/auth/session';
import { anchorExtractHandler } from '../src/jobs/handlers/anchorExtract';
import { runGenerateJob } from '../src/jobs/handlers/generate';
import { GET as getHealth } from '../app/api/health/route';
import { GET as getMe } from '../app/api/me/route';
import { GET as getHistory } from '../app/api/history/route';
import { POST as postPhoto } from '../app/api/photos/route';
import { GET as getPhotoFile } from '../app/api/photos/[id]/file/route';
import { POST as postPreprocess } from '../app/api/photos/[id]/preprocess/route';
import { POST as postAnchor } from '../app/api/anchors/route';
import { GET as getAnchor } from '../app/api/anchors/[id]/route';
import { POST as postConfirm } from '../app/api/anchors/[id]/confirm/route';
import { POST as postGeneration } from '../app/api/generations/route';
import { GET as getGeneration } from '../app/api/generations/[id]/route';

/** 链路输入样本（`docs/prd/spec/07-验收标准.md` §2.4 `E2E-01`；与 `scripts/acceptance.ts` 同一份素材）。 */
const SAMPLE_PHOTO = 'fixtures/images/sample-faded-photo.jpg';

/** 种子里的固定用户（已实名，`migrations/001-init.sql`）。 */
const DEV_USER = 1;

/** 本次冒烟的组合与张数（`docs/prd/tickets/T20-验收：自动化检查与端到端冒烟.md` §4：E4×S3 count=2）。 */
const ERA_CODE = 'E4';
const SCENE_ID = 3;
const COUNT = 2;

interface HealthBody {
  ok: boolean;
  db: { ok: boolean; eras: number; scenes: number; profiles: number };
  provider: { mode: string; arkConfigured: boolean };
  worker: { alive: boolean; lastSeenAt: string | null };
}

/** 一次运行的失败项：期望值 vs 实际值（输出格式见 ticket §4.1）。 */
interface Problem {
  check: string;
  expected: string;
  actual: string;
}

const problems: Problem[] = [];
/** 清理动作（自带清理，`docs/prd/spec/07-验收标准.md` §3）；`main` 的 `finally` 里逆序执行。 */
const cleanups: Array<() => void> = [];

/** 本次链路创建的 id：清理的依据（`docs/prd/spec/07-验收标准.md` §3）。 */
const createdPhotoIds = new Set<number>();
const createdGenerationIds = new Set<number>();
let createdAnchorId: number | null = null;

const step = (line: string): void => console.log(line);

const fail = (check: string, expected: string, actual: string): void => {
  problems.push({ check, expected, actual });
  console.log(`    ✗ ${check}：期望 ${expected}，实际 ${actual}`);
};

/** 进程内构造带 `sid` cookie 的请求（与 `scripts/acceptance.ts` 的 `authedRequest` 同一做法）。 */
const sessionTokens = new Map<number, string>();
const cookieFor = (userId: number): string => {
  const cached = sessionTokens.get(userId);
  if (cached !== undefined) return cached;
  const token = createSession(userId).token;
  sessionTokens.set(userId, token);
  cleanups.push(() => getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)));
  return token;
};

const authedRequest = (url: string, init: RequestInit = {}): NextRequest => {
  const headers = new Headers(init.headers);
  headers.set('cookie', `${SID_COOKIE}=${cookieFor(DEV_USER)}`);
  return new Request(url, { ...init, headers }) as unknown as NextRequest;
};

const jsonRequest = (url: string, payload: unknown): NextRequest =>
  authedRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

/** 删掉本次创建的 `photos` 行与盘上文件（含上传 / 预处理阶段的审核行与审计行）。 */
const purgePhotos = (ids: Iterable<number>): void => {
  for (const id of ids) {
    const row = getDb().prepare('SELECT storage_key FROM photos WHERE id = ?').get(id) as
      | { storage_key: string }
      | undefined;
    if (row !== undefined) {
      try {
        fs.rmSync(getStorage().resolveAbs(row.storage_key), { force: true });
      } catch {
        /* 文件已被清理也不影响判定 */
      }
    }
    getDb().prepare('DELETE FROM audit_logs WHERE target = ?').run(`photo:${id}`);
    getDb()
      .prepare("DELETE FROM content_reviews WHERE target_type = 'photo' AND target_id = ?")
      .run(id);
    getDb().prepare('DELETE FROM photos WHERE id = ?').run(id);
  }
};

/** 删掉一次生成带来的行与磁盘文件（结果照片 + `content_reviews` + `photo.mark` / `generation.finish` 审计）。 */
const purgeGeneration = (generationId: number): void => {
  const photoIds = (
    getDb().prepare('SELECT photo_id FROM generation_results WHERE generation_id = ?').all(generationId) as {
      photo_id: number;
    }[]
  ).map((row) => row.photo_id);
  purgePhotos(photoIds);
  getDb().prepare('DELETE FROM generation_results WHERE generation_id = ?').run(generationId);
  getDb()
    .prepare("DELETE FROM content_reviews WHERE target_type = 'generation' AND target_id = ?")
    .run(generationId);
  getDb().prepare('DELETE FROM audit_logs WHERE target = ?').run(`generation:${generationId}`);
  getDb().prepare('DELETE FROM generations WHERE id = ?').run(generationId);
};

/**
 * 额度计数快照：冒烟的 `count=2` 会预扣当日额度，跑完按差额回滚（`docs/prd/spec/07-验收标准.md` §3），
 * 不污染本地额度；必须在任何 `createGeneration` 之前调用。
 */
const snapshotUsage = (): void => {
  const day = dayKey();
  const row = getDb()
    .prepare('SELECT generations, images FROM usage_counters WHERE user_id = ? AND day = ?')
    .get(DEV_USER, day) as { generations: number; images: number } | undefined;
  cleanups.push(() => {
    getDb().prepare('DELETE FROM usage_counters WHERE user_id = ? AND day = ?').run(DEV_USER, day);
    if (row !== undefined) {
      getDb()
        .prepare('INSERT INTO usage_counters (user_id, day, generations, images) VALUES (?, ?, ?, ?)')
        .run(DEV_USER, day, row.generations, row.images);
    }
  });
};

/** 一次运行的全部清理：生成行 → 锚点 → 照片行与盘上文件 → 会话 / 额度还原。 */
const cleanup = (): void => {
  for (const id of createdGenerationIds) purgeGeneration(id);
  if (createdAnchorId !== null) {
    getDb().prepare('DELETE FROM consents WHERE anchor_id = ?').run(createdAnchorId);
    getDb().prepare('DELETE FROM audit_logs WHERE target = ?').run(`anchor:${createdAnchorId}`);
    hardDeleteAnchor(createdAnchorId, DEV_USER);
  }
  purgePhotos(createdPhotoIds);
  for (const fn of cleanups) fn();
};

const readHistory = async (): Promise<ReturnType<typeof historyListSchema.parse>> =>
  historyListSchema.parse(
    await (await getHistory(authedRequest('http://localhost/api/history?limit=50'), { params: Promise.resolve({}) })).json(),
  );

const resultRows = (generationId: number): { photo_id: number; ordinal: number }[] =>
  getDb()
    .prepare('SELECT photo_id, ordinal FROM generation_results WHERE generation_id = ? ORDER BY ordinal')
    .all(generationId) as { photo_id: number; ordinal: number }[];

const run = async (): Promise<void> => {
  // ── 前置：`GET /api/health`（`docs/prd/spec/03-接口契约.md` §3.7）────────────────────
  const healthRes = await getHealth(new Request('http://localhost/api/health') as unknown as NextRequest, {
    params: Promise.resolve({}),
  });
  const health = (await healthRes.json()) as HealthBody;
  step(
    `[0] GET /api/health → ${healthRes.status} · db.ok=${health.db.ok}（eras=${health.db.eras}, scenes=${health.db.scenes}, profiles=${health.db.profiles}）` +
      ` · worker.alive=${health.worker.alive}（lastSeenAt=${health.worker.lastSeenAt ?? 'null'}） · provider.mode=${health.provider.mode}`,
  );
  if (healthRes.status !== 200 || !health.db.ok) {
    fail(
      '前置：数据库已迁移并 seed',
      '200 且 db.ok=true（eras=4, scenes=5, profiles=20）',
      `${healthRes.status} 且 db.ok=${health.db.ok}（eras=${health.db.eras}, scenes=${health.db.scenes}, profiles=${health.db.profiles}）`,
    );
    console.log('    提示：先在两个终端之外跑 `pnpm migrate && pnpm seed`（docs/prd/spec/08-本地开发指南.md §3）。');
    return;
  }
  if (!health.worker.alive) {
    fail(
      '前置：worker 已启动',
      'worker.alive=true（./data/worker-heartbeat 在 15 秒内更新过）',
      `worker.alive=false（lastSeenAt=${health.worker.lastSeenAt ?? 'null'}）`,
    );
    console.log(
      '    提示：异步任务不会被执行，锚点提取与生图会一直停在 queued。\n' +
        '          请另开一个终端运行 `pnpm worker`，等 5 秒（首个心跳写入）后重跑 `pnpm smoke`\n' +
        '          （排查见 docs/prd/spec/08-本地开发指南.md §3.1）。',
    );
    return;
  }

  // ── ① 登入：DEV_USER 的会话（`docs/prd/modules/M08-账号历史与彻底删除.md` §2.1）──────────
  const me = await getMe(authedRequest('http://localhost/api/me'), { params: Promise.resolve({}) });
  const meBody = (await me.json()) as { user?: { id?: number } };
  step(`[1] GET /api/me → ${me.status}（登入，DEV_USER id=${meBody.user?.id ?? '-'}）`);
  if (me.status !== 200) {
    fail('登入', '200', String(me.status));
    return;
  }

  // ── ② 上传真实样例（`multipart/form-data`，字段 `file`）──────────────────────────────
  const bytes = fs.readFileSync(SAMPLE_PHOTO);
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], path.basename(SAMPLE_PHOTO), { type: 'image/jpeg' }));
  const uploadRes = await postPhoto(authedRequest('http://localhost/api/photos', { method: 'POST', body: form }), {
    params: Promise.resolve({}),
  });
  const originalId = ((await uploadRes.json()) as { photo?: { id?: number } }).photo?.id;
  if (originalId !== undefined) createdPhotoIds.add(originalId);
  step(`[2] POST /api/photos → ${uploadRes.status}（${SAMPLE_PHOTO} → photo id=${originalId ?? '-'}）`);
  if (uploadRes.status !== 201 || originalId === undefined) {
    fail('上传', '201 且响应含 photo.id', String(uploadRes.status));
    return;
  }

  // ── ③ 预处理（幂等；`usable=false` 也 200，但锚点提取会判低质量）──────────────────────
  const preRes = await postPreprocess(
    authedRequest(`http://localhost/api/photos/${originalId}/preprocess`, { method: 'POST' }),
    { params: Promise.resolve({ id: String(originalId) }) },
  );
  const preBody = (await preRes.json()) as { photo?: { id?: number }; quality?: { usable?: boolean } };
  if (preBody.photo?.id !== undefined) createdPhotoIds.add(preBody.photo.id);
  step(`[3] POST /api/photos/${originalId}/preprocess → ${preRes.status}（usable=${String(preBody.quality?.usable)}）`);
  if (preRes.status !== 200 || preBody.photo?.id === undefined || preBody.quality?.usable !== true) {
    fail('预处理', '200 且 quality.usable=true', `${preRes.status} 且 usable=${String(preBody.quality?.usable)}`);
    return;
  }

  // ── ④ 建锚点（`docs/prd/spec/03-接口契约.md` §3.3：`POST /api/anchors` 收 `photoIds`）────
  const anchorRes = await postAnchor(jsonRequest('http://localhost/api/anchors', { photoIds: [originalId] }), {
    params: Promise.resolve({}),
  });
  const createdAnchor = ((await anchorRes.json()) as { anchor?: { id?: number; status?: string } }).anchor;
  createdAnchorId = createdAnchor?.id ?? null;
  step(`[4] POST /api/anchors → ${anchorRes.status}（anchor id=${createdAnchor?.id ?? '-'}，status=${createdAnchor?.status ?? '-'}）`);
  if (anchorRes.status !== 202 || createdAnchorId === null) {
    fail('建锚点', '202 且响应含 anchor.id', `${anchorRes.status} 且 anchor.id=${createdAnchor?.id ?? '-'}`);
    return;
  }
  const anchorId = createdAnchorId;

  // ── ⑤ 轮询至 succeeded：进程内跑该行的 handler 再读端点（无需 HTTP / 真实 worker）────
  const readAnchor = async (): Promise<{ status: string; anchorText: string | null }> => {
    const res = await getAnchor(authedRequest(`http://localhost/api/anchors/${anchorId}`), {
      params: Promise.resolve({ id: String(anchorId) }),
    });
    const anchor = ((await res.json()) as { anchor: { status: string; anchorText: string | null } }).anchor;
    return { status: anchor.status, anchorText: anchor.anchorText };
  };
  let anchorDto = await readAnchor();
  let anchorPolls = 0;
  for (let tries = 0; tries < 5 && anchorDto.status !== 'succeeded' && anchorDto.status !== 'failed'; tries += 1) {
    anchorPolls += 1;
    await anchorExtractHandler({ anchorId });
    anchorDto = await readAnchor();
  }
  step(`[5] GET /api/anchors/${anchorId} → 200（锚点 ${anchorDto.status}，轮询 ${anchorPolls} 次）`);
  if (anchorDto.status !== 'succeeded' || anchorDto.anchorText === null || anchorDto.anchorText === '') {
    fail('锚点提取', 'succeeded 且 anchorText 非空', `${anchorDto.status} 且 anchorText=${anchorDto.anchorText === null ? 'null' : '空串'}`);
    return;
  }

  // ── ⑥ 确认（两项授权缺一不可，`docs/prd/modules/M04-身份确认与授权.md` §5.1）──────────
  const confirmRes = await postConfirm(
    jsonRequest(`http://localhost/api/anchors/${anchorId}/confirm`, {
      confirmed: true,
      consents: ['photo_usage', 'family_agreement'],
    }),
    { params: Promise.resolve({ id: String(anchorId) }) },
  );
  step(`[6] POST /api/anchors/${anchorId}/confirm → ${confirmRes.status}（photo_usage + family_agreement）`);
  if (confirmRes.status !== 200) {
    fail('确认锚点', '200', String(confirmRes.status));
    return;
  }

  // ── ⑦ 生成 E4×S3 count=2 ─────────────────────────────────────────────────────────────
  snapshotUsage();
  const genRes = await postGeneration(
    jsonRequest('http://localhost/api/generations', { anchorId, eraCode: ERA_CODE, sceneId: SCENE_ID, count: COUNT }),
    { params: Promise.resolve({}) },
  );
  const createdGeneration = ((await genRes.json()) as { generation?: { id?: number; status?: string } }).generation;
  const generationId = createdGeneration?.id;
  if (generationId !== undefined) createdGenerationIds.add(generationId);
  step(
    `[7] POST /api/generations → ${genRes.status}（generation id=${generationId ?? '-'}，status=${createdGeneration?.status ?? '-'}，${ERA_CODE}×S${SCENE_ID} count=${COUNT}）`,
  );
  if (genRes.status !== 202 || generationId === undefined) {
    fail('建生成任务', '202 且响应含 generation.id', `${genRes.status} 且 generation.id=${generationId ?? '-'}`);
    return;
  }

  // ── ⑧ 轮询至 succeeded（2 张）：同上，进程内跑生成 handler 再读端点 ──────────────────
  const readGeneration = async (): Promise<{ status: string; results: unknown[] }> => {
    const res = await getGeneration(authedRequest(`http://localhost/api/generations/${generationId}`), {
      params: Promise.resolve({ id: String(generationId) }),
    });
    const generation = ((await res.json()) as { generation: { status: string; results: unknown[] } }).generation;
    return { status: generation.status, results: generation.results };
  };
  let generationDto = await readGeneration();
  let generationPolls = 0;
  for (
    let tries = 0;
    tries < 5 && generationDto.status !== 'succeeded' && !['failed', 'partial'].includes(generationDto.status);
    tries += 1
  ) {
    generationPolls += 1;
    const record = findGenerationById(generationId);
    if (record !== null) await runGenerateJob(record);
    generationDto = await readGeneration();
  }
  step(
    `[8] GET /api/generations/${generationId} → 200（生成 ${generationDto.status}，${generationDto.results.length} 张，轮询 ${generationPolls} 次）`,
  );
  if (generationDto.status !== 'succeeded' || generationDto.results.length !== COUNT) {
    fail('生成', `succeeded 且 ${COUNT} 张结果`, `${generationDto.status} 且 ${generationDto.results.length} 张`);
    return;
  }

  // ── ⑨ 历史可见：该锚点与本次生成都要出现在 `/api/history` ──────────────────────────
  const history = await readHistory();
  const item = history.items.find((entry) => entry.anchorId === anchorId);
  const generationVisible = item?.generations.some((generation) => generation.id === generationId) ?? false;
  step(`[9] GET /api/history → 200（锚点可见=${item !== undefined}，本次生成可见=${generationVisible}）`);
  if (item === undefined) fail('历史可见', '含本次锚点', '历史里没有该锚点');
  else if (!generationVisible) fail('历史可见', '含本次生成', '历史里没有本次生成');

  // ── ⑩ 下载结果图：走 `GET /api/photos/:id/file`，`sharp` 必须解析出宽高 ───────────────
  const resultPhotoId = resultRows(generationId)[0]?.photo_id;
  if (resultPhotoId === undefined) {
    fail('下载结果图', 'generation_results 至少 1 行', '没有结果图可下载');
    return;
  }
  const fileRes = await getPhotoFile(authedRequest(`http://localhost/api/photos/${resultPhotoId}/file`), {
    params: Promise.resolve({ id: String(resultPhotoId) }),
  });
  const meta = await sharp(Buffer.from(await fileRes.arrayBuffer())).metadata();
  step(`[10] GET /api/photos/${resultPhotoId}/file → ${fileRes.status}（sharp 解析 ${String(meta.width)}x${String(meta.height)}）`);
  if (fileRes.status !== 200 || typeof meta.width !== 'number' || typeof meta.height !== 'number') {
    fail(
      '下载结果图',
      '200 且 sharp 解析出宽高',
      `${fileRes.status} 且 ${String(meta.width)}x${String(meta.height)}`,
    );
  }
};

const main = async (): Promise<void> => {
  const args = new Set(process.argv.slice(2));
  const real = args.has('--real');
  // `--real` 强制真实调用；否则沿用 `scripts/acceptance.ts` 的做法：未显式设置 `PROVIDER` 时默认 mock
  // （`docs/prd/spec/08-本地开发指南.md` §5）。
  if (real) process.env.PROVIDER = 'real';
  else if (!process.env.PROVIDER) process.env.PROVIDER = 'mock';

  console.log(
    `[pnpm smoke] E2E-01 端到端冒烟 · PROVIDER=${process.env.PROVIDER ?? 'mock'}` +
      `${real ? '（--real：真实调用，消耗真实额度，人工看图；docs/prd/spec/08-本地开发指南.md §5.2）' : '（mock）'}`,
  );

  try {
    await run();
  } catch (err) {
    fail('链路异常', '无异常抛出', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  } finally {
    cleanup();
  }

  if (problems.length === 0) {
    console.log(`smoke PASS：E2E-01 全链路走通（登入 → 上传 → preprocess → 建锚点 → 提取 → confirm → 生成 ${ERA_CODE}×S${SCENE_ID} count=${COUNT} → 历史 → 下载）`);
    process.exit(0);
  }
  console.log(`smoke FAIL：${problems.length} 项未通过（E2E-01 未走通）`);
  process.exit(1);
};

void main();
