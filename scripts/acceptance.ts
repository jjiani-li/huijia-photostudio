/**
 * `pnpm check:acceptance` —— B 层契约与链路检查的执行器（`docs/prd/spec/07-验收标准.md` §3）。
 *
 * 骨架由 `tickets/T01-项目脚手架与本地开发环境.md` 声明；本条先接上数据层（`DB-01`–`DB-05`、`DB-08`，
 * 直接读库、不需 HTTP）与 prompt 拼装（`PR-01`–`PR-09`）和 `DB-06`（`tickets/T08`，进程内即可判定）；
 * `DB-07` 待 `/api/health` 接上 `db` 计数，HTTP / E2E 用例由 `tickets/T10` / `tickets/T13` / `tickets/T20`
 * 以「修改」方式追加。
 *
 * 输出格式、失败即退出码 1、自带清理见 §3。前置：`pnpm migrate && pnpm seed` 已跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import sharp from 'sharp';
import { getDb } from '../src/server/db/connection';
import { hardDeleteAnchor, insert as insertAnchor } from '../src/server/db/repositories/anchors';
import { readEraSceneConfig } from '../src/server/db/repositories/config';
import { findById as findGenerationById } from '../src/server/db/repositories/generations';
import { insertPhoto } from '../src/server/db/repositories/photos';
import { insert as insertReverseJob } from '../src/server/db/repositories/promptReverseJobs';
import { getDay } from '../src/server/db/repositories/usage';
import { getArk } from '../src/server/ark';
import { MockArkProvider } from '../src/server/ark/mock';
import { readFixture } from '../src/server/ark/fixtures';
import { AIGC_MARKER, readPngText } from '../src/server/images/mark';
import { buildKey, getStorage } from '../src/server/storage';
import { confirmAnchor, revokeConsents } from '../src/server/domain/anchorService';
import {
  assertAnchorGeneratable,
  createGeneration,
  MIN_SIZE_PIXELS,
  retryGeneration,
} from '../src/server/domain/generationService';
import { buildPrompt, PROMPT_MAX_LENGTH, PROMPT_MIN_LENGTH } from '../src/server/prompt/build';
import { SEED_VERSION } from '../src/server/prompt/versions';
import {
  SECTION_AGE,
  SECTION_ERA,
  SECTION_ERA_FIT,
  SECTION_IDENTITY,
  SECTION_PROFILE,
  SECTION_REALISM,
  SECTION_SCENE,
} from '../src/server/prompt/template';
import { AppError } from '../src/server/domain/errors';
import { dayKey, nowIso } from '../src/server/domain/time';
import { reclaimStale } from '../src/jobs/worker';
import { runGenerateJob } from '../src/jobs/handlers/generate';
import { heartbeatPath, writeHeartbeat } from '../src/jobs/heartbeat';
import { SID_COOKIE, createSession, hashToken } from '../src/server/auth/session';
import { GET as getEraSceneConfig } from '../app/api/config/era-scene/route';
import { GET as getHealth } from '../app/api/health/route';
import { GET as getMe } from '../app/api/me/route';
import { POST as postAuthCode } from '../app/api/auth/code/route';

interface CheckResult {
  ok: boolean;
  expected: string;
  actual: string;
}
interface Check {
  id: string;
  dependsOn?: string[];
  run(): CheckResult | Promise<CheckResult>;
}

const EXPECTED_TABLES = [
  'schema_migrations',
  'users',
  'login_codes',
  'sessions',
  'photos',
  'identity_anchors',
  'prompt_reverse_jobs',
  'eras',
  'scenes',
  'era_scene_profiles',
  'generations',
  'generation_results',
  'consents',
  'usage_counters',
  'content_reviews',
  'audit_logs',
].sort();

const CONFIDENCE_HINT = 0.6;
const NEGATION_RE = /不要|禁止|不得出现|no\s/;
/** `PR-03` 的判定正则（`docs/prd/spec/07-验收标准.md` §2.2，含 `without`）。 */
const PROMPT_NEGATION_RE = /不要|禁止|no\s|without/;
/** `PR-05` 的彩色正向词（E1 不得出现）。 */
const PROMPT_COLOR_RE = /彩色胶卷|彩色颗粒|色彩/;
/** `PR-01` 的 6 个固定段落标签（顺序即 `PR-02` 的递增顺序）。 */
const PROMPT_SECTIONS = [
  SECTION_IDENTITY,
  SECTION_AGE,
  SECTION_ERA,
  SECTION_SCENE,
  SECTION_REALISM,
  SECTION_ERA_FIT,
];

const count = (table: string): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const scanConfigWrites = (): string[] => {
  const writeRe =
    /\b(insert\s+into|update|delete\s+from|replace\s+into)\s+(eras|scenes|era_scene_profiles)\b/i;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const rel = path.relative(process.cwd(), full).split(path.sep).join('/');
        if (rel === 'src/server/db/seed.ts') continue; // 种子的唯一写入路径
        if (writeRe.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    }
  };
  for (const root of ['src', 'app']) {
    if (fs.existsSync(root)) walk(root);
  }
  return offenders;
};

const checks: Check[] = [
  {
    id: 'DB-01',
    run: () => {
      const actual = (
        getDb()
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      )
        .map((r) => r.name)
        .sort();
      const ok =
        actual.length === EXPECTED_TABLES.length &&
        actual.every((name, i) => name === EXPECTED_TABLES[i]);
      return { ok, expected: '16/16 tables', actual: `${actual.length}/16 tables` };
    },
  },
  {
    id: 'DB-02',
    run: () => {
      const eras = count('eras');
      const scenes = count('scenes');
      const profiles = count('era_scene_profiles');
      return {
        ok: eras === 4 && scenes === 5 && profiles === 20,
        expected: 'eras=4 scenes=5 profiles=20',
        actual: `eras=${eras} scenes=${scenes} profiles=${profiles}`,
      };
    },
  },
  {
    id: 'DB-03',
    run: () => {
      const rows = getDb().prepare('SELECT code, constraint_pack FROM eras').all() as {
        code: string;
        constraint_pack: string;
      }[];
      const bad = rows.filter((r) => r.constraint_pack.length === 0 || NEGATION_RE.test(r.constraint_pack));
      return { ok: bad.length === 0, expected: '0 命中否定词', actual: `${bad.length} 命中` };
    },
  },
  {
    id: 'DB-04',
    run: () => {
      const rows = getDb().prepare('SELECT confidence FROM era_scene_profiles').all() as {
        confidence: number;
      }[];
      const outOfRange = rows.filter((r) => r.confidence < 0 || r.confidence > 1).length;
      const low = rows.filter((r) => r.confidence < CONFIDENCE_HINT).length;
      return {
        ok: outOfRange === 0 && low === 5,
        expected: '全部 ∈[0,1] 且低置信恰 5 组',
        actual: `越界 ${outOfRange}，低置信 ${low} 组`,
      };
    },
  },
  {
    id: 'DB-05',
    run: () => {
      const rows = getDb().prepare('SELECT code, default_size FROM eras').all() as {
        code: string;
        default_size: string;
      }[];
      const bad = rows.filter((r) => {
        const m = /^(\d+)x(\d+)$/.exec(r.default_size);
        return m === null || Number(m[1]) * Number(m[2]) < MIN_SIZE_PIXELS;
      });
      return { ok: bad.length === 0, expected: `全部 ≥ ${MIN_SIZE_PIXELS}`, actual: `${bad.length} 个不达标` };
    },
  },
  {
    id: 'DB-08',
    run: () => {
      const offenders = scanConfigWrites();
      return { ok: offenders.length === 0, expected: '0 命中', actual: `${offenders.length} 命中 ${offenders.join(',')}` };
    },
  },
];

/** 自带清理：跑完删除本次创建的行与磁盘文件（依据一次运行内记录的 id 列表，§3）。 */
const cleanups: Array<() => void> = [];

// —— `tickets/T07` 的合规拒绝路径（`modules/M04-身份确认与授权.md` §8.2）——
// `SEC-01` / `SEC-02` / `SEC-03` / `SEC-09` 全部进程内直连 domain 层（确认 / 授权 / 守卫），不需 HTTP；
// `POST /api/generations` 落成后（`tickets/T09`），`SEC-01` / `SEC-03` 再转成端到端形态。
const DEV_USER = 1;
/** 锚点样本取自 mock 的成功 fixture（与 `routes.test.ts` 同一事实源）。 */
const ANCHOR_SAMPLE = readFixture<{ anchorText: string; features: Record<string, string> }>(
  'ark/anchor-extract.json',
);

/** 执行一个应抛错的调用，返回错误码（`AppError.code`）或 `'NO_THROW'`。 */
const codeOfThrow = (fn: () => void): string => {
  try {
    fn();
    return 'NO_THROW';
  } catch (err) {
    return err instanceof AppError ? err.code : `ERROR:${String(err)}`;
  }
};

/** 建一个 `succeeded` 锚点（含 `anchor_text` / `features_json`）并登记清理。 */
const makeSucceededAnchor = (): number => {
  const id = insertAnchor({
    userId: DEV_USER,
    inputPhotoIds: [1],
    preprocessedPhotoId: null,
    status: 'succeeded',
    attempt: 0,
    model: 'mock-model',
    promptVersion: 'anchor-v1',
    quality: null,
    createdAt: nowIso(),
  }).id;
  getDb()
    .prepare('UPDATE identity_anchors SET anchor_text = ?, features_json = ?, finished_at = ? WHERE id = ?')
    .run(ANCHOR_SAMPLE.anchorText, JSON.stringify(ANCHOR_SAMPLE.features), nowIso(), id);
  cleanups.push(() => {
    getDb().prepare('DELETE FROM consents WHERE anchor_id = ?').run(id);
    getDb().prepare('DELETE FROM audit_logs WHERE target = ?').run(`anchor:${id}`);
    hardDeleteAnchor(id, DEV_USER);
  });
  return id;
};

checks.push(
  {
    id: 'SEC-01',
    run: () => {
      const id = makeSucceededAnchor(); // `confirmed_by_user` 默认 0
      const code = codeOfThrow(() => assertAnchorGeneratable(DEV_USER, id));
      return { ok: code === 'ANCHOR_NOT_CONFIRMED', expected: 'ANCHOR_NOT_CONFIRMED', actual: code };
    },
  },
  {
    id: 'SEC-02',
    run: () => {
      const id = makeSucceededAnchor();
      const code = codeOfThrow(() => confirmAnchor(DEV_USER, id, ['photo_usage']));
      const confirmed = (
        getDb().prepare('SELECT confirmed_by_user FROM identity_anchors WHERE id = ?').get(id) as {
          confirmed_by_user: number;
        }
      ).confirmed_by_user;
      const consents = (
        getDb().prepare('SELECT COUNT(*) AS n FROM consents WHERE anchor_id = ?').get(id) as { n: number }
      ).n;
      return {
        ok: code === 'INVALID_PARAM' && confirmed === 0 && consents === 0,
        expected: 'INVALID_PARAM 且 confirmed_by_user=0 / consents=0',
        actual: `${code} confirmed=${confirmed} consents=${consents}`,
      };
    },
  },
  {
    id: 'SEC-03',
    run: () => {
      const id = makeSucceededAnchor();
      confirmAnchor(DEV_USER, id, ['photo_usage', 'family_agreement']);
      revokeConsents(DEV_USER, 'photo_usage');
      const code = codeOfThrow(() => assertAnchorGeneratable(DEV_USER, id));
      return { ok: code === 'CONSENT_REQUIRED', expected: 'CONSENT_REQUIRED', actual: code };
    },
  },
  {
    id: 'SEC-09',
    run: () => {
      const id = makeSucceededAnchor();
      confirmAnchor(DEV_USER, id, ['photo_usage', 'family_agreement']);
      const audit = (
        getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('anchor.confirm','consent.agree') AND target = ?",
          )
          .get(`anchor:${id}`) as { n: number }
      ).n;
      const consents = (
        getDb()
          .prepare('SELECT COUNT(*) AS n FROM consents WHERE anchor_id = ? AND revoked_at IS NULL')
          .get(id) as { n: number }
      ).n;
      return {
        ok: audit === 2 && consents === 2,
        expected: '2 条审计 + 2 行有效 consents',
        actual: `audit=${audit} consents=${consents}`,
      };
    },
  },
);

// —— `tickets/T08` prompt 拼装（`docs/prd/modules/M05-年代场景配置与Prompt拼装.md` §8）：进程内跑 20 组 (E,S)，不需 HTTP ——
const promptCases = (() => {
  const config = readEraSceneConfig();
  const eraByCode = new Map(config.eras.map((e) => [e.code, e]));
  const sceneById = new Map(config.scenes.map((s) => [s.id, s]));
  return config.profiles.map((profile) => {
    const era = eraByCode.get(profile.eraCode);
    const scene = sceneById.get(profile.sceneId);
    if (era === undefined || scene === undefined) throw new Error('种子组合引用了缺失的年代 / 场景');
    return {
      era,
      scene,
      profile,
      out: buildPrompt({ anchorText: ANCHOR_SAMPLE.anchorText, era, scene, profile }),
    };
  });
})();

const combosSatisfy = (predicate: (c: (typeof promptCases)[number]) => boolean): CheckResult => {
  const bad = promptCases.filter((c) => !predicate(c));
  return {
    ok: bad.length === 0,
    expected: `${promptCases.length}/${promptCases.length} 通过`,
    actual: `${promptCases.length - bad.length}/${promptCases.length} 通过`,
  };
};

/**
 * 已登录请求（`tickets/T12` 的真实会话）：懒建一条 `DEV_USER` 的会话，受保护端点的直调都带上 `sid` cookie；
 * 建行时登记清理（§3 的「自带清理」）。
 */
let sid: string | null = null;
const authedRequest = (url: string, init: RequestInit = {}): NextRequest => {
  if (sid === null) {
    const token = createSession(DEV_USER).token;
    sid = token;
    cleanups.push(() => getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)));
  }
  const headers = new Headers(init.headers);
  headers.set('cookie', `${SID_COOKIE}=${sid}`);
  return new Request(url, { ...init, headers }) as unknown as NextRequest;
};

const jsonRequest = (url: string, payload: unknown): NextRequest =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }) as unknown as NextRequest;

/** 进程内直调配置端点（与 `tickets/T03` 的 `routes.test.ts` 同一做法），供 `API-06` / `DB-06` 取响应体。 */
const readConfigResponse = async (): Promise<Record<string, unknown>> => {
  const res = await getEraSceneConfig(authedRequest('http://localhost/api/config/era-scene'), {
    params: Promise.resolve({}),
  });
  return (await res.json()) as Record<string, unknown>;
};

checks.push(
  {
    id: 'PR-01',
    run: () => combosSatisfy((c) => PROMPT_SECTIONS.every((label) => c.out.prompt.includes(label))),
  },
  {
    id: 'PR-02',
    run: () =>
      combosSatisfy((c) => {
        const idx = PROMPT_SECTIONS.map((label) => c.out.prompt.indexOf(label));
        return idx.every((v, i) => i === 0 || v > idx[i - 1]);
      }),
  },
  { id: 'PR-03', run: () => combosSatisfy((c) => !PROMPT_NEGATION_RE.test(c.out.prompt)) },
  {
    id: 'PR-04',
    run: () => combosSatisfy((c) => c.out.prompt.includes('不做任何美化') && c.out.prompt.includes('减龄')),
  },
  {
    id: 'PR-05',
    run: () =>
      combosSatisfy(
        (c) => c.era.code !== 'E1' || (c.out.prompt.includes('黑白') && !PROMPT_COLOR_RE.test(c.out.prompt)),
      ),
  },
  {
    id: 'PR-06',
    run: () =>
      combosSatisfy((c) => (c.era.code !== 'E3' && c.era.code !== 'E4') || !c.out.prompt.includes('胶片')),
  },
  {
    id: 'PR-07',
    run: () =>
      combosSatisfy((c) => c.out.prompt.length >= PROMPT_MIN_LENGTH && c.out.prompt.length <= PROMPT_MAX_LENGTH),
  },
  {
    id: 'PR-08',
    run: () =>
      combosSatisfy((c) => {
        const again = buildPrompt({
          anchorText: ANCHOR_SAMPLE.anchorText,
          era: c.era,
          scene: c.scene,
          profile: c.profile,
        });
        return again.prompt === c.out.prompt && again.promptHash === c.out.promptHash;
      }),
  },
  {
    id: 'PR-09',
    run: () =>
      combosSatisfy((c) => {
        const override = c.profile.promptOverride;
        // `null` 或全空白都整段省略（`docs/prd/modules/M05-年代场景配置与Prompt拼装.md` §5.1 规则 4）。
        if (override === null || override.trim() === '') return !c.out.prompt.includes(SECTION_PROFILE);
        return c.out.prompt.endsWith(SECTION_PROFILE + override);
      }),
  },
  {
    id: 'API-06',
    run: async () => {
      const body = await readConfigResponse();
      const serialized = JSON.stringify(body);
      const leaked = ['promptPack', 'spacePack', 'constraintPack', 'promptOverride'].filter((key) =>
        serialized.includes(key),
      );
      return {
        ok: leaked.length === 0,
        expected: '0 命中 prompt 正文四字段',
        actual: `${leaked.length} 命中${leaked.length > 0 ? ` ${leaked.join(',')}` : ''}`,
      };
    },
  },
  {
    id: 'DB-06',
    run: async () => {
      const body = (await readConfigResponse()) as { version?: unknown };
      const seed = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'docs/prd/spec/era-scene-seed.json'), 'utf8'),
      ) as { version: string };
      return {
        ok: body.version === seed.version && body.version === SEED_VERSION,
        expected: `version=${seed.version}`,
        actual: `version=${String(body.version)}`,
      };
    },
  },
);

// —— `tickets/T12` 账号、会话与额度（`modules/M08` §2.1、§5.1）：真实会话、脱敏、节流、devCode ——

checks.push(
  {
    id: 'API-03',
    run: async () => {
      const res = await getMe(new Request('http://localhost/api/me') as unknown as NextRequest, {
        params: Promise.resolve({}),
      });
      const body = (await res.json()) as { error?: { code?: string } };
      return {
        ok: res.status === 401 && body.error?.code === 'UNAUTHENTICATED',
        expected: '未登录访问 /api/me → 401 UNAUTHENTICATED',
        actual: `${res.status} ${body.error?.code ?? ''}`,
      };
    },
  },
  {
    // `API-05` 的另一半（`/api/history` 响应无明文手机号/邮箱）随 `tickets/T13` 的该端点落地后补（见 T12 §Comments）。
    id: 'API-05',
    run: async () => {
      const res = await getMe(authedRequest('http://localhost/api/me'), { params: Promise.resolve({}) });
      const body = (await res.json()) as {
        user?: { phone?: string | null; email?: string | null };
        quota?: { limit?: number };
      };
      const phone = body.user?.phone ?? null;
      const serialized = JSON.stringify(body);
      const masked = phone === null || phone.includes('*');
      const noPlain = !serialized.includes('13800000000');
      const quotaOk = typeof body.quota?.limit === 'number';
      return {
        ok: res.status === 200 && masked && noPlain && quotaOk,
        expected: '200；user.phone 含 * 且无明文；quota.limit 为数值',
        actual: `status=${res.status} phone=${String(phone)} 无明文=${noPlain} limit=${String(body.quota?.limit)}`,
      };
    },
  },
  {
    id: 'API-07',
    run: async () => {
      const identifier = '13700000001';
      cleanups.push(() => getDb().prepare('DELETE FROM login_codes WHERE identifier = ?').run(identifier));
      const first = await postAuthCode(jsonRequest('http://localhost/api/auth/code', { identifier }), {
        params: Promise.resolve({}),
      });
      const second = await postAuthCode(jsonRequest('http://localhost/api/auth/code', { identifier }), {
        params: Promise.resolve({}),
      });
      const body = (await second.json()) as { error?: { code?: string } };
      return {
        ok: first.status === 200 && second.status === 429 && body.error?.code === 'CODE_RATE_LIMITED',
        expected: '60 秒内二次发码 → 429 CODE_RATE_LIMITED',
        actual: `${first.status} → ${second.status} ${body.error?.code ?? ''}`,
      };
    },
  },
  {
    id: 'SEC-07',
    run: async () => {
      const saved = process.env.SMS_PROVIDER;
      const consoleId = '13700000002';
      const realId = '13700000003';
      cleanups.push(() =>
        getDb().prepare('DELETE FROM login_codes WHERE identifier IN (?, ?)').run(consoleId, realId),
      );
      try {
        process.env.SMS_PROVIDER = 'console';
        const consoleRes = await postAuthCode(jsonRequest('http://localhost/api/auth/code', { identifier: consoleId }), {
          params: Promise.resolve({}),
        });
        const consoleBody = (await consoleRes.json()) as { devCode?: string };

        process.env.SMS_PROVIDER = 'real';
        const realRes = await postAuthCode(jsonRequest('http://localhost/api/auth/code', { identifier: realId }), {
          params: Promise.resolve({}),
        });
        const realBody = (await realRes.json()) as { error?: { code?: string } };
        const realSerialized = JSON.stringify(realBody);

        return {
          ok:
            consoleRes.status === 200 &&
            /^\d{6}$/.test(consoleBody.devCode ?? '') &&
            realRes.status === 500 &&
            realBody.error?.code === 'INTERNAL' &&
            !realSerialized.includes('devCode'),
          expected: 'console → 200 带 devCode；real → 500 INTERNAL 且无 devCode',
          actual: `console=${consoleRes.status}/${String(consoleBody.devCode)} real=${realRes.status}/${realBody.error?.code ?? ''} devCode 泄漏=${realSerialized.includes('devCode')}`,
        };
      } finally {
        if (saved === undefined) delete process.env.SMS_PROVIDER;
        else process.env.SMS_PROVIDER = saved;
      }
    },
  },
);

// —— `tickets/T09` 生成编排（`docs/prd/modules/M06-生成编排.md` §5）：进程内直连 domain 层，不需 HTTP ——

const healthRequest = { method: 'GET', nextUrl: { pathname: '/api/health' } } as unknown as NextRequest;

interface HealthBody {
  ok: boolean;
  db: { ok: boolean; eras: number; scenes: number; profiles: number };
  worker: { alive: boolean; lastSeenAt: string | null };
}

/** 进程内直调健康检查端点（与配置端点同一做法），供 `DB-07` / `ERR-04` 取响应体。 */
const readHealthBody = async (): Promise<HealthBody> => {
  const res = await getHealth(healthRequest, { params: Promise.resolve({}) });
  return (await res.json()) as HealthBody;
};

/**
 * 额度计数快照：脚本跑完按差额回滚（§3 的「自带清理」），不污染本地额度。
 * 只在第一次调用时取快照（后续 check 的预扣都基于同一起点），必须在任何 `createGeneration` 之前调用。
 */
let usageSnapshotTaken = false;
const snapshotUsage = (): void => {
  if (usageSnapshotTaken) return;
  usageSnapshotTaken = true;
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

/** 删掉本次创建的生成行与它带来的审计行。 */
const deleteGenerations = (ids: number[]): void => {
  for (const id of ids) {
    getDb().prepare('DELETE FROM generation_results WHERE generation_id = ?').run(id);
    getDb().prepare('DELETE FROM audit_logs WHERE target = ?').run(`generation:${id}`);
    getDb().prepare('DELETE FROM generations WHERE id = ?').run(id);
  }
};

const currentQuota = (): number =>
  (getDb().prepare('SELECT daily_image_quota AS q FROM users WHERE id = ?').get(DEV_USER) as { q: number }).q;

const setQuota = (limit: number): void => {
  getDb().prepare('UPDATE users SET daily_image_quota = ? WHERE id = ?').run(limit, DEV_USER);
};

/** `reference_photo_ids` 用：一张 `kind='preprocessed'` 的行（不落盘，`E2E-04` 只看库）。 */
let preprocessedPhotoId: number | null = null;
const sharedPreprocessedPhoto = (): number => {
  if (preprocessedPhotoId === null) {
    const photo = insertPhoto({
      userId: DEV_USER,
      kind: 'preprocessed',
      storageKey: `u${DEV_USER}/acceptance-preprocessed.jpg`,
      mime: 'image/jpeg',
      bytes: 1,
      width: 1600,
      height: 1200,
      sha256: 'd'.repeat(64),
      sourcePhotoId: null,
      qualityJson: null,
      createdAt: nowIso(),
    });
    preprocessedPhotoId = photo.id;
    cleanups.push(() => {
      getDb().prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
    });
  }
  return preprocessedPhotoId;
};

/** 可以走完 8 步的锚点：`succeeded` + 已确认 + `photo_usage` + 有 `anchor_text` + 预处理图。 */
const makeReadyAnchor = (): number => {
  const id = makeSucceededAnchor();
  getDb()
    .prepare(
      `UPDATE identity_anchors SET preprocessed_photo_id = ?, confirmed_by_user = 1,
              confirmed_at = ?, anchor_text = ? WHERE id = ?`,
    )
    .run(sharedPreprocessedPhoto(), nowIso(), ANCHOR_SAMPLE.anchorText, id);
  getDb()
    .prepare("INSERT INTO consents (user_id, scope, anchor_id, agreed_at) VALUES (?, 'photo_usage', ?, ?)")
    .run(DEV_USER, id, nowIso());
  return id;
};

/** `createGeneration` 现为 `async`（prompt 阶段审核要 await 上游），本文件一律 `await`。 */
const createFor = async (anchorId: number, count: number) =>
  createGeneration({ userId: DEV_USER, anchorId, eraCode: 'E2', sceneId: 1, count });

const codeOfCreate = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'NO_THROW';
  } catch (err) {
    return err instanceof AppError ? err.code : `ERROR:${String(err)}`;
  }
};

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

checks.push(
  {
    id: 'SEC-04',
    run: async () => {
      const anchorId = makeReadyAnchor();
      snapshotUsage();
      const limit = currentQuota();
      const before = count('generations');
      try {
        setQuota(1);
        const code = await codeOfCreate(() => createFor(anchorId, 2));
        setQuota(limit);
        const after = count('generations');
        return {
          ok: code === 'QUOTA_EXCEEDED' && after === before,
          expected: 'QUOTA_EXCEEDED 且未产生 generations 行',
          actual: `${code}，generations ${before}→${after}`,
        };
      } finally {
        setQuota(limit);
      }
    },
  },
  {
    id: 'SEC-05',
    run: async () => {
      const anchorId = makeReadyAnchor();
      snapshotUsage();
      const created: number[] = [];
      try {
        const first = await createFor(anchorId, 2);
        created.push(first.id);
        cleanups.push(() => deleteGenerations(created));
        const code = await codeOfCreate(() => createFor(anchorId, 2));
        const rows = (
          getDb().prepare('SELECT COUNT(*) AS n FROM generations WHERE id = ?').get(first.id) as { n: number }
        ).n;
        return {
          ok: code === 'GENERATION_IN_PROGRESS' && rows === 1,
          expected: 'GENERATION_IN_PROGRESS 且只留第一行',
          actual: `${code}，第一行 ${rows} 条`,
        };
      } finally {
        deleteGenerations(created);
      }
    },
  },
  {
    id: 'E2E-04',
    run: async () => {
      const anchorId = makeReadyAnchor();
      snapshotUsage();
      const created: number[] = [];
      try {
        const record = await createFor(anchorId, 2);
        created.push(record.id);
        cleanups.push(() => deleteGenerations(created));
        const photoId = record.referencePhotoIds[0];
        const kind =
          record.referencePhotoIds.length === 1 && photoId !== undefined
            ? (getDb().prepare('SELECT kind FROM photos WHERE id = ?').get(photoId) as { kind: string } | undefined)
                ?.kind
            : undefined;
        return {
          ok: record.referencePhotoIds.length === 1 && kind === 'preprocessed',
          expected: 'reference_photo_ids 恰 1 个 id 且该 photo kind=preprocessed',
          actual: `n=${record.referencePhotoIds.length} kind=${String(kind)}`,
        };
      } finally {
        deleteGenerations(created);
      }
    },
  },
  {
    id: 'E2E-09',
    run: async () => {
      const anchorId = makeReadyAnchor();
      snapshotUsage();
      const created: number[] = [];
      try {
        const first = await createFor(anchorId, 2);
        created.push(first.id);
        cleanups.push(() => deleteGenerations(created));
        getDb()
          .prepare("UPDATE generations SET status = 'succeeded', finished_at = ? WHERE id = ?")
          .run(nowIso(), first.id);
        const beforeOld = JSON.stringify(
          getDb().prepare('SELECT * FROM generations WHERE id = ?').get(first.id),
        );

        const second = await retryGeneration({ userId: DEV_USER, generationId: first.id });
        created.push(second.id);

        const afterOld = JSON.stringify(getDb().prepare('SELECT * FROM generations WHERE id = ?').get(first.id));
        const ok =
          second.id !== first.id &&
          second.status === 'queued' &&
          second.attempt === 0 &&
          second.requestedCount === first.requestedCount &&
          second.anchorId === first.anchorId &&
          afterOld === beforeOld;
        return {
          ok,
          expected: '新行 attempt=0，旧行逐列不变',
          actual: `new=${second.id}/${second.status}/attempt=${second.attempt}，旧行未变=${afterOld === beforeOld}`,
        };
      } finally {
        deleteGenerations(created);
      }
    },
  },
  {
    id: 'ERR-02',
    run: async () => {
      const anchorId = makeReadyAnchor();
      const created: number[] = [];
      let jobId: number | null = null;
      try {
        // 先入队（此时锚点仍可生成），再把三张表各造一行「1 小时前的 running」。
        snapshotUsage();
        const generation = await createFor(anchorId, 2);
        created.push(generation.id);
        cleanups.push(() => deleteGenerations(created));
        getDb()
          .prepare("UPDATE generations SET status = 'running', attempt = 1, started_at = ? WHERE id = ?")
          .run(HOUR_AGO, generation.id);

        getDb()
          .prepare("UPDATE identity_anchors SET status = 'running', attempt = 2, started_at = ? WHERE id = ?")
          .run(HOUR_AGO, anchorId);
        const job = insertReverseJob({
          userId: DEV_USER,
          sourcePhotoId: sharedPreprocessedPhoto(),
          model: 'acceptance-vision-model',
          status: 'running',
          attempt: 1,
          createdAt: nowIso(),
        });
        jobId = job.id;
        cleanups.push(() => {
          getDb().prepare('DELETE FROM prompt_reverse_jobs WHERE id = ?').run(job.id);
        });
        getDb().prepare('UPDATE prompt_reverse_jobs SET started_at = ? WHERE id = ?').run(HOUR_AGO, job.id);

        const reclaimed = reclaimStale(10);

        const rows: Array<[string, number, number]> = [
          ['identity_anchors', anchorId, 2],
          ['prompt_reverse_jobs', job.id, 1],
          ['generations', generation.id, 1],
        ];
        const bad = rows.filter(([table, id, attempt]) => {
          const row = getDb()
            .prepare(`SELECT status, started_at, attempt FROM ${table} WHERE id = ?`)
            .get(id) as { status: string; started_at: string | null; attempt: number };
          return row.status !== 'queued' || row.started_at !== null || row.attempt !== attempt;
        });
        return {
          ok:
            bad.length === 0 &&
            reclaimed.anchors >= 1 &&
            reclaimed.promptReverseJobs >= 1 &&
            reclaimed.generations >= 1,
          expected: '三张表的陈旧 running 都回到 queued（attempt 不变）',
          actual:
            bad.length === 0
              ? `回收 ${
                  reclaimed.anchors + reclaimed.promptReverseJobs + reclaimed.generations
                } 行（锚点 ${reclaimed.anchors} / 反推 ${reclaimed.promptReverseJobs} / 生成 ${reclaimed.generations}）`
              : `${bad.length} 张表未回收：${bad.map(([t]) => t).join(',')}`,
        };
      } finally {
        deleteGenerations(created);
        if (jobId !== null) getDb().prepare('DELETE FROM prompt_reverse_jobs WHERE id = ?').run(jobId);
      }
    },
  },
  {
    id: 'ERR-04',
    run: async () => {
      const file = heartbeatPath();
      const hadFile = fs.existsSync(file);
      fs.rmSync(file, { force: true });
      cleanups.push(() => {
        if (hadFile) writeHeartbeat();
        else fs.rmSync(file, { force: true });
      });

      const before = (await readHealthBody()).worker;
      writeHeartbeat();
      const after = (await readHealthBody()).worker;
      return {
        ok:
          before.alive === false &&
          before.lastSeenAt === null &&
          after.alive === true &&
          typeof after.lastSeenAt === 'string',
        expected: '无心跳文件 alive=false / lastSeenAt=null；写入后 alive=true',
        actual: `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      };
    },
  },
  {
    id: 'DB-07',
    run: async () => {
      const body = await readHealthBody();
      return {
        ok: body.db.eras === 4 && body.db.scenes === 5 && body.db.profiles === 20,
        expected: 'db.eras / scenes / profiles = 4 / 5 / 20',
        actual: `db.ok=${body.db.ok} eras=${body.db.eras} scenes=${body.db.scenes} profiles=${body.db.profiles}`,
      };
    },
  },
);

// ── `tickets/T10` Seedream 生图调用与结果转存（`modules/M06-生成编排.md` §5.9、`spec/06` §3）──
// 进程内直调 handler（`runGenerateJob`），不经 HTTP：`E2E-05`–`E2E-08`、`CMP-01`、`CMP-03`、`CMP-04`
// 与 T09 延后的 `ERR-01` / `ERR-05`。每个用例自带清理（结果照片行 + 磁盘文件 + 审计行）。

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/**
 * 造一张「文件真实存在」的 `preprocessed` 图：生成 handler 要读盘取 Base64，
 * `E2E-04` 用的那张占位行（`bytes=1`、不落盘）会让 handler 直接 `STORAGE_ERROR`。
 */
const makePreprocessedWithFile = async (): Promise<number> => {
  const buffer = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 210, g: 180, b: 150 } },
  })
    .png()
    .toBuffer();
  const key = buildKey(DEV_USER, 'png');
  await getStorage().save(key, buffer);
  const photo = insertPhoto({
    userId: DEV_USER,
    kind: 'preprocessed',
    storageKey: key,
    mime: 'image/png',
    bytes: buffer.length,
    width: 64,
    height: 64,
    sha256: sha256(buffer),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  });
  cleanups.push(() => {
    try {
      fs.rmSync(getStorage().resolveAbs(key), { force: true });
    } catch {
      /* 文件已被清理也不影响判定 */
    }
  });
  cleanups.push(() => {
    getDb().prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  });
  return photo.id;
};

/** 可走完生成链路的锚点：`succeeded` + 已确认 + `photo_usage` + `anchor_text` + **盘上有文件**的预处理图。 */
const makeGeneratableAnchor = async (): Promise<number> => {
  const photoId = await makePreprocessedWithFile();
  const id = makeSucceededAnchor();
  getDb()
    .prepare(
      `UPDATE identity_anchors SET preprocessed_photo_id = ?, confirmed_by_user = 1,
              confirmed_at = ?, anchor_text = ? WHERE id = ?`,
    )
    .run(photoId, nowIso(), ANCHOR_SAMPLE.anchorText, id);
  getDb()
    .prepare("INSERT INTO consents (user_id, scope, anchor_id, agreed_at) VALUES (?, 'photo_usage', ?, ?)")
    .run(DEV_USER, id, nowIso());
  return id;
};

/** 删掉一次生成带来的行与磁盘文件（结果照片 + `photo.mark` / `generation.finish` 审计）。 */
/**
 * 删掉一次生成带来的行与磁盘文件（结果照片 + `photo.mark` / `generation.finish` 审计 + `content_reviews`）。
 * `extraPhotoIds` 用于收录**内容审核被拒、没有 `generation_results` 行**的软删生成图（`SEC-08`）。
 */
const purgeGeneration = (generationId: number, extraPhotoIds: number[] = []): void => {
  const photoIds = [
    ...(
      getDb()
        .prepare('SELECT photo_id FROM generation_results WHERE generation_id = ?')
        .all(generationId) as { photo_id: number }[]
    ).map((r) => r.photo_id),
    ...extraPhotoIds,
  ];
  for (const photoId of photoIds) {
    const row = getDb().prepare('SELECT storage_key FROM photos WHERE id = ?').get(photoId) as
      | { storage_key: string }
      | undefined;
    if (row !== undefined) {
      try {
        fs.rmSync(getStorage().resolveAbs(row.storage_key), { force: true });
      } catch {
        /* 文件已被清理也不影响判定 */
      }
    }
    getDb().prepare('DELETE FROM audit_logs WHERE target = ?').run(`photo:${photoId}`);
    getDb().prepare('DELETE FROM photos WHERE id = ?').run(photoId);
  }
  getDb().prepare('DELETE FROM generation_results WHERE generation_id = ?').run(generationId);
  getDb()
    .prepare('DELETE FROM content_reviews WHERE target_type = ? AND target_id = ?')
    .run('generation', generationId);
  getDb().prepare('DELETE FROM audit_logs WHERE target = ?').run(`generation:${generationId}`);
  getDb().prepare('DELETE FROM generations WHERE id = ?').run(generationId);
};

/** 审核 fixture 的路径与开关写入 / 还原（`modules/M07` §7.2–§7.3，`SEC-08` 用）。 */
const SAFETY_FIXTURE = 'fixtures/ark/safety-review.json';

const setSafetyVariant = (stage: 'upload' | 'prompt' | 'result', variantId: string | null): void => {
  const parsed = JSON.parse(fs.readFileSync(SAFETY_FIXTURE, 'utf8')) as {
    switchVariants: Record<string, string | null>;
  };
  parsed.switchVariants[stage] = variantId;
  fs.writeFileSync(SAFETY_FIXTURE, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
};

const softDeletedGeneratedCount = (): number =>
  (getDb().prepare("SELECT COUNT(*) AS n FROM photos WHERE kind = 'generated' AND deleted_at IS NOT NULL").get() as {
    n: number;
  }).n;

const contentReviewRows = (
  generationId: number,
  stage: string,
): { verdict: string; reason: string | null }[] =>
  getDb()
    .prepare(
      "SELECT verdict, reason FROM content_reviews WHERE target_type = 'generation' AND target_id = ? AND stage = ?",
    )
    .all(generationId, stage) as { verdict: string; reason: string | null }[];

const moderationRejectRows = (generationId: number): { meta_json: string | null }[] =>
  getDb()
    .prepare("SELECT meta_json FROM audit_logs WHERE action = 'moderation.reject' AND target = ?")
    .all(`generation:${generationId}`) as { meta_json: string | null }[];

interface ResultRow {
  photo_id: number;
  ordinal: number;
  seed: number | null;
}

const resultRows = (generationId: number): ResultRow[] =>
  getDb()
    .prepare('SELECT photo_id, ordinal, seed FROM generation_results WHERE generation_id = ? ORDER BY ordinal')
    .all(generationId) as ResultRow[];

const generationRow = (generationId: number): { status: string; attempt: number; error_code: string | null } =>
  getDb()
    .prepare('SELECT status, attempt, error_code FROM generations WHERE id = ?')
    .get(generationId) as { status: string; attempt: number; error_code: string | null };

/** 结果照片行（`photos` 侧）：`E2E-06` / `CMP-01` 的读盘对象。 */
const resultPhotos = (
  generationId: number,
): { id: number; kind: string; storage_key: string; bytes: number; sha256: string }[] =>
  getDb()
    .prepare(
      `SELECT p.id, p.kind, p.storage_key, p.bytes, p.sha256 FROM generation_results r
       JOIN photos p ON p.id = r.photo_id WHERE r.generation_id = ? ORDER BY r.ordinal`,
    )
    .all(generationId) as { id: number; kind: string; storage_key: string; bytes: number; sha256: string }[];

const readResultFile = (generationId: number, index: number): Buffer => {
  const photo = resultPhotos(generationId)[index];
  if (photo === undefined) throw new Error(`generation ${generationId} 没有第 ${index} 张结果`);
  return fs.readFileSync(getStorage().resolveAbs(photo.storage_key));
};

const markAuditRows = (photoIds: number[]): { meta_json: string | null }[] => {
  if (photoIds.length === 0) return [];
  const placeholders = photoIds.map(() => '?').join(', ');
  return getDb()
    .prepare(
      `SELECT meta_json FROM audit_logs WHERE action = 'photo.mark' AND target IN (${placeholders})`,
    )
    .all(...photoIds.map((id) => `photo:${id}`)) as { meta_json: string | null }[];
};

const parseMeta = (row: { meta_json: string | null }): Record<string, unknown> =>
  row.meta_json === null ? {} : (JSON.parse(row.meta_json) as Record<string, unknown>);

let quotaRaised = false;
/**
 * T10 的用例要真跑生成（每次预扣 `count`），而 T09 的用例留下的预扣没有回滚，
 * DEV_USER 的默认额度（20）会被撞满。这里临时抬高上限并在跑完还原（自带清理的一部分）。
 */
const raiseQuotaForGenerationChecks = (): void => {
  if (quotaRaised) return;
  quotaRaised = true;
  const limit = currentQuota();
  setQuota(10_000);
  cleanups.push(() => setQuota(limit));
};

/**
 * 每个用例一份独立的锚点与生成行：入队 → 调 handler → 断言 → 清理（行 + 盘上文件）。
 * `imagesBefore` 在入队（预扣）之前取，供 `E2E-08` 量净增。
 */
const withGeneration = async <T>(
  count: number,
  fn: (ctx: { id: number; imagesBefore: number }) => Promise<T> | T,
): Promise<T> => {
  raiseQuotaForGenerationChecks();
  const anchorId = await makeGeneratableAnchor();
  snapshotUsage();
  const imagesBefore = getDay(DEV_USER, dayKey()).images;
  // 审核被拒的生成图没有 `generation_results` 行，只能按「跑之前不存在的 photos 行」收录后清理。
  const photosBefore = new Set(
    (getDb().prepare('SELECT id FROM photos').all() as { id: number }[]).map((row) => row.id),
  );
  const record = await createFor(anchorId, count);
  const cleanup = (): void => {
    const newPhotos = (getDb().prepare('SELECT id FROM photos').all() as { id: number }[])
      .map((row) => row.id)
      .filter((id) => !photosBefore.has(id));
    purgeGeneration(record.id, newPhotos);
  };
  cleanups.push(cleanup);
  try {
    return await fn({ id: record.id, imagesBefore });
  } finally {
    cleanup();
  }
};

/** 直调 handler（与 worker 的调用形态一致：先读行再执行）。 */
const runGeneration = async (generationId: number): Promise<void> => {
  const record = findGenerationById(generationId);
  if (record === null) throw new Error(`generation ${generationId} 不存在`);
  await runGenerateJob(record);
};

/** 取锚点的预处理图（`CMP-01` 的「非生成文件读不到标识」样本）。 */
const preprocessedStorageKey = (generationId: number): string => {
  const row = getDb().prepare('SELECT reference_photo_ids FROM generations WHERE id = ?').get(generationId) as
    | { reference_photo_ids: string }
    | undefined;
  const ids = JSON.parse(row?.reference_photo_ids ?? '[]') as number[];
  const photoId = ids[0];
  const photo = getDb().prepare('SELECT storage_key FROM photos WHERE id = ?').get(photoId) as
    | { storage_key: string }
    | undefined;
  return photo?.storage_key ?? '';
};

checks.push(
  {
    id: 'E2E-05',
    run: () =>
      withGeneration(3, async ({ id }) => {
        await runGeneration(id);
        const rows = resultRows(id);
        const ordinals = rows.map((r) => r.ordinal);
        const { status } = generationRow(id);
        const ok =
          rows.length === 3 && ordinals.every((value, index) => value === index) && status === 'succeeded';
        return {
          ok,
          expected: '3 行结果、ordinal=0,1,2、status=succeeded',
          actual: `${rows.length} 行、ordinal=${ordinals.join(',')}、status=${status}`,
        };
      }),
  },
  {
    id: 'E2E-06',
    run: () =>
      withGeneration(3, async ({ id }) => {
        await runGeneration(id);
        const photos = resultPhotos(id);
        const bad = photos.filter((photo) => {
          const abs = getStorage().resolveAbs(photo.storage_key);
          return (
            photo.kind !== 'generated' || !fs.existsSync(abs) || fs.statSync(abs).size !== photo.bytes
          );
        });
        return {
          ok: photos.length === 3 && bad.length === 0,
          expected: '3 张 kind=generated、盘上文件存在且字节数 == photos.bytes',
          actual: `${photos.length} 张、不合规 ${bad.length} 张`,
        };
      }),
  },
  {
    id: 'E2E-07',
    run: () =>
      withGeneration(3, async ({ id }) => {
        await runGeneration(id);
        const distinct = new Set(resultPhotos(id).map((photo) => photo.sha256));
        return {
          ok: distinct.size >= 2,
          expected: '≥ 2 张结果 sha256 互异',
          actual: `${distinct.size} 个不同的 sha256`,
        };
      }),
  },
  {
    id: 'E2E-08',
    run: () =>
      withGeneration(3, async ({ id, imagesBefore }) => {
        await runGeneration(id);
        const after = getDay(DEV_USER, dayKey()).images;
        return {
          ok: after - imagesBefore === 3 && generationRow(id).status === 'succeeded',
          expected: `usage_counters.images 净增 3（${imagesBefore} → ${imagesBefore + 3}）`,
          actual: `净增 ${after - imagesBefore}（${imagesBefore} → ${after}）`,
        };
      }),
  },
  {
    id: 'CMP-01',
    run: () =>
      withGeneration(3, async ({ id }) => {
        await runGeneration(id);
        const generated = resultPhotos(id);
        const markers = generated.map((_photo, index) => readPngText(readResultFile(id, index), 'AIGC'));
        const preprocessed = readPngText(
          fs.readFileSync(getStorage().resolveAbs(preprocessedStorageKey(id))),
          'AIGC',
        );
        return {
          ok: markers.length === 3 && markers.every((value) => value === AIGC_MARKER) && preprocessed === null,
          expected: '3 张生成图都能读回 AIGC == AIGC_MARKER；预处理图读不到',
          actual: `生成图命中 ${markers.filter((v) => v === AIGC_MARKER).length}/3，预处理图=${String(preprocessed)}`,
        };
      }),
  },
  {
    id: 'CMP-03',
    run: () =>
      withGeneration(3, async ({ id }) => {
        await runGeneration(id);
        const photoIds = resultRows(id).map((row) => row.photo_id);
        const audits = markAuditRows(photoIds);
        const failed = audits.filter((row) => parseMeta(row).mode === 'failed');
        return {
          ok: audits.length === photoIds.length && failed.length === 0,
          expected: 'photo.mark 行数 == 生成张数、无 meta_json.mode=failed',
          actual: `${audits.length} 行审计、mode=failed ${failed.length} 行`,
        };
      }),
  },
  {
    id: 'CMP-04',
    run: () =>
      withGeneration(2, async ({ id }) => {
        const saved = process.env.AIGC_IMPLICIT_MARKER;
        process.env.AIGC_IMPLICIT_MARKER = 'false';
        try {
          await runGeneration(id);
          const photoIds = resultRows(id).map((row) => row.photo_id);
          const audits = markAuditRows(photoIds);
          const modes = audits.map((row) => parseMeta(row).mode);
          const markers = resultPhotos(id).map((_photo, index) => readPngText(readResultFile(id, index), 'AIGC'));
          return {
            ok:
              audits.length === photoIds.length &&
              modes.length > 0 &&
              modes.every((mode) => mode === 'off') &&
              markers.every((value) => value === null),
            expected: '审计行照写且 mode=off、文件读不到标识',
            actual: `${audits.length} 行审计 mode=${modes.join(',')}、文件命中 ${markers.filter((v) => v !== null).length}`,
          };
        } finally {
          if (saved === undefined) delete process.env.AIGC_IMPLICIT_MARKER;
          else process.env.AIGC_IMPLICIT_MARKER = saved;
        }
      }),
  },
  {
    id: 'ERR-01',
    run: () =>
      withGeneration(2, async ({ id }) => {
        const provider = getArk() as MockArkProvider;
        provider.setFailure('timeout');
        try {
          // 第一次：零产出的瞬时错误 → 自动重试一次（attempt 0 → 1，回到 queued）
          await runGeneration(id);
          const mid = generationRow(id);
          // 第二次：attempt 已用掉 → 落 failed
          await runGeneration(id);
          const row = generationRow(id);
          return {
            ok:
              mid.status === 'queued' &&
              mid.attempt === 1 &&
              row.status === 'failed' &&
              row.error_code === 'PROVIDER_TIMEOUT' &&
              row.attempt === 1,
            expected: '重试一次后 failed / PROVIDER_TIMEOUT / attempt=1',
            actual: `中间态 ${mid.status}/${mid.attempt}，终态 ${row.status}/${row.error_code}/${row.attempt}`,
          };
        } finally {
          provider.setFailure(null);
        }
      }),
  },
  {
    id: 'ERR-05',
    run: () =>
      withGeneration(2, async ({ id }) => {
        const provider = getArk() as MockArkProvider;
        provider.setFailure('model-not-open');
        try {
          await runGeneration(id);
          const row = generationRow(id);
          return {
            ok: row.status === 'failed' && row.error_code === 'PROVIDER_ERROR' && row.attempt === 0,
            expected: 'failed / PROVIDER_ERROR / attempt=0（不可重试）',
            actual: `${row.status}/${row.error_code}/${row.attempt}`,
          };
        } finally {
          provider.setFailure(null);
        }
      }),
  },
  {
    // `SEC-08`（`docs/prd/modules/M07-生成后复核与内容审核.md` §8 归属本模块）：把
    // `switchVariants.result` 置为 `reject-violation` → 全部张被拒（`n === 0`）→ 任务 `failed` +
    // `CONTENT_REJECTED`，被拒张不写 `generation_results` 行，写 `content_reviews(stage='result')` 与
    // `audit_logs(action='moderation.reject')`，被拒的已转存图立即软删。**跑完必须还原开关**。
    id: 'SEC-08',
    run: () =>
      withGeneration(2, async ({ id }) => {
        const original = fs.readFileSync(SAFETY_FIXTURE, 'utf8');
        const softDeletedBefore = softDeletedGeneratedCount();
        setSafetyVariant('result', 'reject-violation');
        try {
          await runGeneration(id);
          const row = generationRow(id);
          const results = resultRows(id);
          const reviews = contentReviewRows(id, 'result');
          const rejects = moderationRejectRows(id);
          const softDeleted = softDeletedGeneratedCount() - softDeletedBefore;
          const ok =
            row.status === 'failed' &&
            row.error_code === 'CONTENT_REJECTED' &&
            results.length === 0 &&
            reviews.length === 1 &&
            reviews[0]?.verdict === 'reject' &&
            rejects.length === 1 &&
            softDeleted === 1;
          return {
            ok,
            expected: 'failed/CONTENT_REJECTED、无结果行、1 行 content_reviews(reject)、1 行 moderation.reject、被拒图软删',
            actual: `${row.status}/${row.error_code}、结果行 ${results.length}、reviews ${reviews.length}(${reviews[0]?.verdict ?? '-'})、reject 审计 ${rejects.length}、软删 ${softDeleted}`,
          };
        } finally {
          fs.writeFileSync(SAFETY_FIXTURE, original, 'utf8');
        }
      }),
  },
);

const main = async (): Promise<void> => {
  // `spec/07-验收标准.md` §2 前置：mock provider（未显式设置时默认 mock，避免 Windows 下 shell 前缀不通用）。
  if (!process.env.PROVIDER) process.env.PROVIDER = 'mock';
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failedIds = new Set<string>();

  try {
    for (const check of checks) {
      if (check.dependsOn?.some((d) => failedIds.has(d))) {
        skipped += 1;
        console.log(`[${check.id}] - skipped（依赖失败）`);
        continue;
      }
      let result: CheckResult;
      try {
        result = await check.run();
      } catch (err) {
        result = { ok: false, expected: '无异常', actual: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) {
        passed += 1;
        console.log(`[${check.id}] ✓ ${result.actual}`);
      } else {
        failed += 1;
        failedIds.add(check.id);
        console.log(`[${check.id}] ✗ 期望 ${result.expected}，实际 ${result.actual}`);
      }
    }
  } finally {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        /* 清理失败不影响判定 */
      }
    }
  }

  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
};

void main();