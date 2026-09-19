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
import { insertUser } from '../src/server/db/repositories/users';
import { insert as insertReverseJob } from '../src/server/db/repositories/promptReverseJobs';
import { getDay } from '../src/server/db/repositories/usage';
import { getArk } from '../src/server/ark';
import { MockArkProvider } from '../src/server/ark/mock';
import { readFixture } from '../src/server/ark/fixtures';
import { AIGC_MARKER, readPngText } from '../src/server/images/mark';
import { buildKey, getStorage } from '../src/server/storage';
import { confirmAnchor, revokeConsents } from '../src/server/domain/anchorService';
import { deletePhoto } from '../src/server/domain/deletionService';
import { historyListSchema } from '../src/shared/types';
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
import { runPurge } from '../src/jobs/handlers/purge';
import { heartbeatPath, writeHeartbeat } from '../src/jobs/heartbeat';
import { SID_COOKIE, createSession, hashToken } from '../src/server/auth/session';
import { promptReverseJobSchema } from '../src/shared/types';
import { configReverseDomain, parseReverseResponse, reversePromptHandler } from '../src/jobs/handlers/reversePrompt';
import { markSucceeded } from '../src/server/db/repositories/promptReverseJobs';
import { POST as postReverseJob } from '../app/api/prompt-reverse-jobs/route';
import { GET as getReverseJob } from '../app/api/prompt-reverse-jobs/[id]/route';
import { GET as getEraSceneConfig } from '../app/api/config/era-scene/route';
import { GET as getHealth } from '../app/api/health/route';
import { GET as getMe } from '../app/api/me/route';
import { GET as getHistory } from '../app/api/history/route';
import { DELETE as deletePhotoRoute } from '../app/api/photos/[id]/route';
import { GET as getPhotoFile } from '../app/api/photos/[id]/file/route';
import { POST as postAuthCode } from '../app/api/auth/code/route';
import { POST as postPhoto } from '../app/api/photos/route';
import { GET as getRealName, POST as postRealName } from '../app/api/me/realname/route';

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
/** 各用户名的 `sid` 明文（`tickets/T19` 起需要不止一个用户：未实名 / 已实名 / 占用者）。 */
const sessionTokens = new Map<number, string>();
const cookieFor = (userId: number): string => {
  const cached = sessionTokens.get(userId);
  if (cached !== undefined) return cached;
  const token = createSession(userId).token;
  sessionTokens.set(userId, token);
  cleanups.push(() => getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)));
  return token;
};
const requestWithUser = (userId: number, url: string, init: RequestInit = {}): NextRequest => {
  const headers = new Headers(init.headers);
  headers.set('cookie', `${SID_COOKIE}=${cookieFor(userId)}`);
  return new Request(url, { ...init, headers }) as unknown as NextRequest;
};
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
      const unauth = (url: string, init: RequestInit = {}): NextRequest =>
        new Request(url, init) as unknown as NextRequest;
      const calls = [
        { name: '/api/me', res: await getMe(unauth('http://localhost/api/me'), { params: Promise.resolve({}) }) },
        {
          name: '/api/config/era-scene',
          res: await getEraSceneConfig(unauth('http://localhost/api/config/era-scene'), { params: Promise.resolve({}) }),
        },
        {
          name: 'POST /api/photos',
          res: await postPhoto(unauth('http://localhost/api/photos', { method: 'POST' }), { params: Promise.resolve({}) }),
        },
      ];
      const results = await Promise.all(
        calls.map(async (call) => ({
          name: call.name,
          status: call.res.status,
          code: ((await call.res.json()) as { error?: { code?: string } }).error?.code ?? '',
        })),
      );
      return {
        ok: results.every((r) => r.status === 401 && r.code === 'UNAUTHENTICATED'),
        expected: '3 个受保护端点未登录 → 401 UNAUTHENTICATED',
        actual: results.map((r) => `${r.name}:${r.status}/${r.code}`).join('  '),
      };
    },
  },
  {
    // `API-05`：`/api/me` 的脱敏 + `/api/history` 响应体内无明文手机号 / 邮箱（`tickets/T13` 补齐后半）。
    id: 'API-05',
    run: async () => {
      const res = await getMe(authedRequest('http://localhost/api/me'), { params: Promise.resolve({}) });
      const body = (await res.json()) as {
        user?: { phone?: string | null; email?: string | null };
        quota?: { limit?: number };
      };
      const phone = body.user?.phone ?? null;
      const serialized = JSON.stringify(body);
      // 钉死脱敏后的形状（DEV_USER 手机号 13800000000），不能只判"含 * 或 null"。
      const masked = phone === '138****0000';
      const noPlain = !serialized.includes('13800000000');
      const quotaOk = typeof body.quota?.limit === 'number';

      const historyRes = await getHistory(authedRequest('http://localhost/api/history?limit=50'), {
        params: Promise.resolve({}),
      });
      const historyBody = (await historyRes.json()) as { items?: unknown };
      const historyClean =
        historyRes.status === 200 &&
        !JSON.stringify(historyBody).includes('13800000000') &&
        !JSON.stringify(historyBody).includes('@');
      return {
        ok: res.status === 200 && masked && noPlain && quotaOk && historyClean,
        expected: '200；user.phone === 138****0000 且无明文；quota.limit 为数值；/api/history 无明文手机号/邮箱',
        actual: `status=${res.status} phone=${String(phone)} 无明文=${noPlain} limit=${String(body.quota?.limit)} history=${historyRes.status}/clean=${historyClean}`,
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
const createFor = async (anchorId: number, count: number, userId: number = DEV_USER) =>
  createGeneration({ userId, anchorId, eraCode: 'E2', sceneId: 1, count });

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

// ── `tickets/T13` 历史链路、级联删除与物理清理（`modules/M08-账号历史与彻底删除.md` §4–6）──
// `DEL-01`–`DEL-04`、`CMP-05`：进程内直调 history / photos / purge，链路用真实生成跑通（自带清理）。

const ONE_HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

const readHistory = async (): Promise<ReturnType<typeof historyListSchema.parse>> =>
  historyListSchema.parse(
    await (
      await getHistory(authedRequest('http://localhost/api/history?limit=50'), { params: Promise.resolve({}) })
    ).json(),
  );

/** 造一张「盘上有文件、已软删且早于宽限期」的照片，供 purge 用例；自带清理。 */
const makePurgeablePhoto = async (): Promise<{ id: number; storageKey: string }> => {
  const buffer = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  const key = buildKey(DEV_USER, 'png');
  await getStorage().save(key, buffer);
  const photo = insertPhoto({
    userId: DEV_USER,
    kind: 'original',
    storageKey: key,
    mime: 'image/png',
    bytes: buffer.length,
    width: 32,
    height: 32,
    sha256: sha256(buffer),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  });
  getDb().prepare('UPDATE photos SET deleted_at = ? WHERE id = ?').run(ONE_HOUR_AGO, photo.id);
  cleanups.push(() => {
    try {
      fs.rmSync(getStorage().resolveAbs(key), { force: true });
    } catch {
      /* 文件已被清理也不影响判定 */
    }
  });
  cleanups.push(() => getDb().prepare('DELETE FROM photos WHERE id = ?').run(photo.id));
  return { id: photo.id, storageKey: key };
};

/** 完整可删链路：原图 → 预处理图（盘上有文件）→ 已确认锚点 → 生成任务跑出结果。 */
const makeDeletableChain = async (): Promise<{ original: number; anchorId: number }> => {
  raiseQuotaForGenerationChecks();
  snapshotUsage();
  const preprocessed = await makePreprocessedWithFile();
  const original = insertPhoto({
    userId: DEV_USER,
    kind: 'original',
    storageKey: `u${DEV_USER}/acceptance-${Math.random().toString(16).slice(2)}.jpg`,
    mime: 'image/jpeg',
    bytes: 1,
    width: 1600,
    height: 1200,
    sha256: 'c'.repeat(64),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  });
  cleanups.push(() => getDb().prepare('DELETE FROM photos WHERE id = ?').run(original.id));

  const anchorId = insertAnchor({
    userId: DEV_USER,
    inputPhotoIds: [original.id],
    preprocessedPhotoId: preprocessed,
    status: 'succeeded',
    attempt: 0,
    model: 'mock-model',
    promptVersion: 'anchor-v1',
    quality: null,
    createdAt: nowIso(),
  }).id;
  getDb()
    .prepare(
      `UPDATE identity_anchors SET anchor_text = ?, features_json = ?, confirmed_by_user = 1,
              confirmed_at = ? WHERE id = ?`,
    )
    .run(ANCHOR_SAMPLE.anchorText, JSON.stringify(ANCHOR_SAMPLE.features), nowIso(), anchorId);
  getDb()
    .prepare("INSERT INTO consents (user_id, scope, anchor_id, agreed_at) VALUES (?, 'photo_usage', ?, ?)")
    .run(DEV_USER, anchorId, nowIso());
  cleanups.push(() => {
    getDb().prepare('DELETE FROM consents WHERE anchor_id = ?').run(anchorId);
    getDb().prepare('DELETE FROM audit_logs WHERE target = ?').run(`anchor:${anchorId}`);
    hardDeleteAnchor(anchorId, DEV_USER);
  });

  const photosBefore = new Set(
    (getDb().prepare('SELECT id FROM photos').all() as { id: number }[]).map((row) => row.id),
  );
  const generationId = (await createFor(anchorId, 2)).id;
  const record = findGenerationById(generationId);
  if (record !== null) await runGenerateJob(record);
  cleanups.push(() =>
    purgeGeneration(
      generationId,
      (getDb().prepare('SELECT id FROM photos').all() as { id: number }[])
        .map((row) => row.id)
        .filter((id) => !photosBefore.has(id)),
    ),
  );
  return { original: original.id, anchorId };
};

checks.push(
  {
    id: 'DEL-01',
    run: async () => {
      const chain = await makeDeletableChain();
      const seenBefore = (await readHistory()).items.some((item) => item.anchorId === chain.anchorId);
      const res = await deletePhotoRoute(
        authedRequest(`http://localhost/api/photos/${chain.original}`, { method: 'DELETE' }),
        { params: Promise.resolve({ id: String(chain.original) }) },
      );
      const body = (await res.json()) as { ok: boolean; cascaded: Record<string, number> };
      const seenAfter = (await readHistory()).items.some((item) => item.anchorId === chain.anchorId);
      const anchorGone =
        (getDb().prepare('SELECT COUNT(*) AS n FROM identity_anchors WHERE id = ?').get(chain.anchorId) as {
          n: number;
        }).n === 0;
      const ok =
        res.status === 200 &&
        seenBefore &&
        !seenAfter &&
        anchorGone &&
        (body.cascaded.anchors ?? 0) >= 1 &&
        (body.cascaded.generations ?? 0) >= 1 &&
        (body.cascaded.results ?? 0) >= 1;
      return {
        ok,
        expected: 'DELETE 后该锚点从 /api/history 消失、级联计数非零',
        actual: `before=${seenBefore} after=${seenAfter} status=${res.status} cascaded=${JSON.stringify(body.cascaded)}`,
      };
    },
  },
  {
    id: 'DEL-02',
    run: async () => {
      const chain = await makeDeletableChain();
      deletePhoto({ userId: DEV_USER, photoId: chain.original });
      const res = await getPhotoFile(
        authedRequest(`http://localhost/api/photos/${chain.original}/file`),
        { params: Promise.resolve({ id: String(chain.original) }) },
      );
      return { ok: res.status === 404, expected: '删除后取图 → 404', actual: `status=${res.status}` };
    },
  },
  {
    id: 'DEL-03',
    run: async () => {
      const photo = await makePurgeablePhoto();
      const result = await runPurge();
      const rowGone =
        (getDb().prepare('SELECT COUNT(*) AS n FROM photos WHERE id = ?').get(photo.id) as { n: number }).n === 0;
      const fileGone = !fs.existsSync(getStorage().resolveAbs(photo.storageKey));
      return {
        ok: result.purged >= 1 && rowGone && fileGone,
        expected: 'runPurge() 后文件与 photos 行物理消失',
        actual: `purged=${result.purged} rowGone=${rowGone} fileGone=${fileGone}`,
      };
    },
  },
  {
    id: 'DEL-04',
    run: async () => {
      const id = insertPhoto({
        userId: DEV_USER,
        kind: 'original',
        storageKey: `u${DEV_USER}/acceptance-audit-${Math.random().toString(16).slice(2)}.jpg`,
        mime: 'image/jpeg',
        bytes: 1,
        width: 800,
        height: 600,
        sha256: 'b'.repeat(64),
        sourcePhotoId: null,
        qualityJson: null,
        createdAt: nowIso(),
      }).id;
      cleanups.push(() => getDb().prepare('DELETE FROM photos WHERE id = ?').run(id));
      deletePhoto({ userId: DEV_USER, photoId: id });
      await makePurgeablePhoto();
      await runPurge();

      const deletes = (getDb().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'photo.delete'").get() as {
        n: number;
      }).n;
      const purges = (getDb().prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'photo.purge'").get() as {
        n: number;
      }).n;
      return {
        ok: deletes >= 1 && purges >= 1,
        expected: 'audit_logs 存在 photo.delete 与 photo.purge',
        actual: `photo.delete=${deletes} photo.purge=${purges}`,
      };
    },
  },
  {
    id: 'CMP-05',
    run: async () => {
      await makePurgeablePhoto();
      const first = await runPurge();
      const second = await runPurge();
      return {
        ok: first.purged >= 1 && second.scanned === 0 && second.purged === 0,
        expected: '第二次 runPurge() 返回 scanned=0 / purged=0',
        actual: `第一次 purged=${first.purged}，第二次 scanned=${second.scanned} purged=${second.purged}`,
      };
    },
  },
  {
    // ── `tickets/T17` 情感安全提示（`docs/prd/spec/07-验收标准.md` §2.8、`spec/06-合规与风控.md` §9.2：CMP-06）──
    // 静态扫描，不读库、不发请求：语义句落点 + 会话态不落 web storage（`pages/P00` §6）。
    id: 'CMP-06',
    run: () => {
      // 语义与触发口径见 `docs/prd/spec/06-合规与风控.md` §9.2、`docs/prd/pages/P04-失败与情绪安全路径.md` §4；
      // 检测口径：语义句至少落在一处源码（两段都要），且这四个目录**没有**把状态写进 web storage。
      const SEMANTICS = ['基于照片的重建', '无法替代真实'];
      const files: { path: string; text: string }[] = [];
      const walk = (dir: string): void => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
          files.push({
            path: path.relative(process.cwd(), full).split(path.sep).join('/'),
            text: fs.readFileSync(full, 'utf8'),
          });
        }
      };
      for (const root of ['app', 'components', 'hooks', 'src']) walk(root);

      const carriers = files.filter((f) => SEMANTICS.every((s) => f.text.includes(s)));
      // 只认真正的读写调用（`localStorage.setItem(...)` / `window.sessionStorage[key]`）；
      // 注释与测试里的「不落 localStorage」字样不算（`pages/P00-设计基准与路由.md` §6 的措辞禁令）。
      const storageRe = /(?:window\.)?(?:local|session)Storage\s*[.[]/;
      const storers = files.filter((f) => storageRe.test(f.text));

      return {
        ok: carriers.length >= 1 && storers.length === 0,
        expected:
          '语义句（含「基于照片的重建」与「无法替代真实」）至少落在一处；app/components/hooks/src 无 localStorage / sessionStorage 读写',
        actual: `语义句落点=${carriers.map((f) => f.path).join(',') || '(无)'}；存储读写=${storers.map((f) => f.path).join(',') || '(无)'}`,
      };
    },
  },
);

// ── `tickets/T18` 图片反推提示词（`docs/prd/modules/M09-图片反推提示词.md` §9：API-08、REV-01–REV-03）──
// 进程内直调两个端点与 handler，不经 HTTP；每个用例自带清理（反推行 + 照片行 + 磁盘文件）。

/** `docs/prd/spec/03-接口契约.md` §4 的 `PromptReverseJob` 字段全集（多一个少一个都算漂移）。 */
const REVERSE_JOB_KEYS = [
  'createdAt',
  'error',
  'finishedAt',
  'id',
  'model',
  'photoId',
  'resultJson',
  'resultPrompt',
  'status',
  'suggestEraCode',
  'suggestSceneId',
].sort();

const encodeErrorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error?: { code?: string } }).error?.code ?? '';

/** `POST /api/prompt-reverse-jobs`（可传任意请求体，供形状用例造非法输入）。 */
const reversePost = (payload: unknown): Promise<Response> =>
  postReverseJob(
    authedRequest('http://localhost/api/prompt-reverse-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({}) },
  );

const reverseGet = (id: number): Promise<Response> =>
  getReverseJob(authedRequest(`http://localhost/api/prompt-reverse-jobs/${id}`), {
    params: Promise.resolve({ id: String(id) }),
  });

/** 建一张 `kind='generated'` 的行（`POST` 的 400 分支用），登记清理。 */
const insertGeneratedPhoto = (): number => {
  const photo = insertPhoto({
    userId: DEV_USER,
    kind: 'generated',
    storageKey: `u${DEV_USER}/acceptance-generated.jpg`,
    mime: 'image/jpeg',
    bytes: 1,
    width: 1024,
    height: 1024,
    sha256: 'e'.repeat(64),
    sourcePhotoId: null,
    qualityJson: null,
    createdAt: nowIso(),
  });
  cleanups.push(() => getDb().prepare('DELETE FROM photos WHERE id = ?').run(photo.id));
  return photo.id;
};

/** 入队一张反推任务并登记清理；返回 `jobId`。 */
const enqueueReverse = async (photoId: number): Promise<number> => {
  const res = await reversePost({ photoId });
  if (res.status !== 202) throw new Error(`入队失败：${res.status} ${JSON.stringify(await res.json())}`);
  const jobId = ((await res.json()) as { job: { id: number } }).job.id;
  cleanups.push(() => getDb().prepare('DELETE FROM prompt_reverse_jobs WHERE id = ?').run(jobId));
  return jobId;
};

const reverseRow = (jobId: number): Record<string, unknown> =>
  getDb().prepare('SELECT * FROM prompt_reverse_jobs WHERE id = ?').get(jobId) as Record<string, unknown>;

/** 跑通一条链路：真实文件的照片 → 入队 → handler → `GET`，返回响应里的 `job`。 */
const runReverseOnce = async (): Promise<Record<string, unknown>> => {
  const jobId = await enqueueReverse(await makePreprocessedWithFile());
  await reversePromptHandler({ jobId });
  return ((await (await reverseGet(jobId)).json()) as { job: Record<string, unknown> }).job;
};

checks.push(
  {
    id: 'API-08',
    run: async () => {
      const created = await reversePost({ photoId: sharedPreprocessedPhoto() });
      const createdBody = (await created.json()) as { job?: Record<string, unknown> };
      const job = createdBody.job ?? {};
      const jobId = typeof job.id === 'number' ? job.id : null;
      if (jobId !== null) {
        cleanups.push(() => getDb().prepare('DELETE FROM prompt_reverse_jobs WHERE id = ?').run(jobId));
      }

      const read = await reverseGet(jobId ?? 0);
      const readBody = (await read.json()) as { job?: Record<string, unknown> };
      const readJob = readBody.job ?? {};

      const declaredKeys = (record: Record<string, unknown>): boolean =>
        JSON.stringify(Object.keys(record).sort()) === JSON.stringify(REVERSE_JOB_KEYS);
      const envelopeOnly = (body: Record<string, unknown>): boolean => Object.keys(body).length === 1 && 'job' in body;

      const invalid = await reversePost({});
      const wrongType = await reversePost({ photoId: '1' });
      const unknown = await reversePost({ photoId: 999_999 });
      const generated = await reversePost({ photoId: insertGeneratedPhoto() });

      const ok =
        created.status === 202 &&
        read.status === 200 &&
        job.status === 'queued' &&
        declaredKeys(job) &&
        declaredKeys(readJob) &&
        envelopeOnly(createdBody) &&
        envelopeOnly(readBody) &&
        promptReverseJobSchema.safeParse(job).success &&
        promptReverseJobSchema.safeParse(readJob).success &&
        invalid.status === 400 &&
        wrongType.status === 400 &&
        unknown.status === 404 &&
        (await encodeErrorCode(unknown)) === 'NOT_FOUND' &&
        generated.status === 400 &&
        (await encodeErrorCode(generated)) === 'INVALID_PARAM';

      return {
        ok,
        expected: `202/200；job 恰 ${REVERSE_JOB_KEYS.length} 键；缺参 400 / 照片不存在 404 / 结果图 400`,
        actual: `202=${created.status} 200=${read.status} 键=${Object.keys(job).length}/${Object.keys(readJob).length} 缺参=${invalid.status} 类型错=${wrongType.status} 不存在=${unknown.status} 结果图=${generated.status}`,
      };
    },
  },
  {
    id: 'REV-01',
    run: async () => {
      const job = await runReverseOnce();
      const detail = (job.resultJson ?? {}) as Record<string, unknown>;
      const fiveKeys = ['scene', 'lighting', 'era', 'wardrobe', 'composition'];
      const keysOk = JSON.stringify(Object.keys(detail).sort()) === JSON.stringify([...fiveKeys].sort());
      const allNonEmpty = fiveKeys.every(
        (key) => typeof detail[key] === 'string' && (detail[key] as string).length > 0,
      );
      const promptOk = typeof job.resultPrompt === 'string' && job.resultPrompt.length > 0;
      // 「推荐年代代号与场景 id 齐全」：两个键必须在响应里，且回放样本（E2 × S3）取到非空推荐。
      const suggestionsGiven =
        'suggestEraCode' in job && 'suggestSceneId' in job && typeof job.suggestEraCode === 'string' && Number.isInteger(job.suggestSceneId);
      const shapeOk = promptReverseJobSchema.safeParse(job).success;
      return {
        ok: job.status === 'succeeded' && keysOk && allNonEmpty && promptOk && suggestionsGiven && shapeOk,
        expected: 'succeeded；五键非空 + resultPrompt 非空 + 推荐年代 / 场景齐全 + 形状走 shared schema',
        actual: `status=${String(job.status)} 键=[${Object.keys(detail).sort().join(',')}] 全非空=${allNonEmpty} prompt=${promptOk} 推荐=${String(job.suggestEraCode)}/${String(job.suggestSceneId)} schema=${shapeOk}`,
      };
    },
  },
  {
    id: 'REV-02',
    run: async () => {
      const job = await runReverseOnce();
      const row = reverseRow(job.id as number);
      const era = row.suggest_era_code as string | null;
      const scene = row.suggest_scene_id as number | null;

      const eraOk = era === null || (typeof era === 'string' && ['E1', 'E2', 'E3', 'E4'].includes(era));
      const eraInTable = era === null || getDb().prepare('SELECT 1 FROM eras WHERE code = ?').get(era) !== undefined;
      const sceneOk = scene === null || (Number.isInteger(scene) && scene > 0);
      const sceneInTable =
        scene === null || getDb().prepare('SELECT 1 FROM scenes WHERE id = ?').get(scene) !== undefined;

      // 「越界由实现置 NULL、不判失败」：直接把越界 / 类型不符的推荐值喂给解析与落库（回放样本恒为合法值，
      // 走不了这条分支），该行仍须是 `succeeded` 且两列为 NULL。
      const outOfRangeId = (
        await enqueueReverse(await makePreprocessedWithFile())
      );
      getDb().prepare("UPDATE prompt_reverse_jobs SET status = 'running' WHERE id = ?").run(outOfRangeId);
      const parsed = parseReverseResponse(
        JSON.stringify({
          scene: '室内堂屋',
          lighting: '左侧窗户斜射的自然光，色温偏冷',
          era: '约在二十世纪八十年代，黑白胶片',
          wardrobe: '深色中山装，短寸发型',
          composition: '中景，人物居中略偏左',
          result_prompt: '黑白老照片质感，室内堂屋正面机位',
          suggest_era_code: 'E99',
          suggest_scene_id: '3',
        }),
        configReverseDomain,
      );
      let outOfRangeOk = false;
      if (parsed.ok) {
        markSucceeded({
          id: outOfRangeId,
          result: parsed.result,
          resultPrompt: parsed.resultPrompt,
          suggestEraCode: parsed.suggestEraCode,
          suggestSceneId: parsed.suggestSceneId,
          finishedAt: nowIso(),
        });
        const outRow = reverseRow(outOfRangeId);
        outOfRangeOk = outRow.status === 'succeeded' && outRow.suggest_era_code === null && outRow.suggest_scene_id === null;
      }

      return {
        ok: eraOk && eraInTable && sceneOk && sceneInTable && outOfRangeOk,
        expected:
          'suggest_era_code ∈ {E1..E4}∪{NULL} 且落在 eras.code；suggest_scene_id 为 INTEGER∪{NULL} 且落在 scenes.id；越界置 NULL 仍 succeeded',
        actual: `era=${String(era)}（在 eras=${eraInTable}） scene=${String(scene)}（在 scenes=${sceneInTable}） 越界置 NULL 仍 succeeded=${outOfRangeOk}`,
      };
    },
  },
  {
    id: 'REV-03',
    run: async () => {
      // ① 重复反推 = 插新行，不覆盖旧行（`modules/M09` §3）。
      const photoId = await makePreprocessedWithFile();
      const first = await enqueueReverse(photoId);
      const queuedRow = reverseRow(first);
      const second = await enqueueReverse(photoId);
      const secondQueued = reverseRow(second);

      // ② queued → succeeded：产物与状态可查。
      await reversePromptHandler({ jobId: first });
      const succeededRow = reverseRow(first);
      const succeededDto = (await (await reverseGet(first)).json()) as { job: Record<string, unknown> };

      // ③ queued → failed：入队后源照片被软删，worker 落终态而不是把 AppError 抛出去。
      const failingPhoto = await makePreprocessedWithFile();
      const third = await enqueueReverse(failingPhoto);
      getDb().prepare('UPDATE photos SET deleted_at = ? WHERE id = ?').run(nowIso(), failingPhoto);
      await reversePromptHandler({ jobId: third });
      const failedRow = reverseRow(third);
      const failedDto = (await (await reverseGet(third)).json()) as {
        job: { status: string; error: { code: string; message: string } | null };
      };

      const ok =
        first !== second &&
        queuedRow.status === 'queued' &&
        queuedRow.result_json === null &&
        // 旧行逐列不变（仍是 queued、无产物）
        secondQueued.status === 'queued' &&
        succeededRow.status === 'succeeded' &&
        succeededRow.started_at !== null &&
        typeof succeededRow.result_json === 'string' &&
        typeof succeededRow.result_prompt === 'string' &&
        succeededRow.finished_at !== null &&
        // 「产物与状态可查」：`GET` 也必须能看到 succeeded 与两个产物字段
        succeededDto.job.status === 'succeeded' &&
        succeededDto.job.resultJson !== null &&
        typeof succeededDto.job.resultPrompt === 'string' &&
        failedRow.status === 'failed' &&
        failedRow.error_code === 'INTERNAL' &&
        typeof failedRow.error_message === 'string' &&
        failedRow.error_message !== '' &&
        failedDto.job.status === 'failed' &&
        failedDto.job.error !== null &&
        failedDto.job.error.code === 'INTERNAL' &&
        typeof failedDto.job.error.message === 'string';

      return {
        ok,
        expected:
          'queued → succeeded（`GET` 可见产物与状态）；另起一行 queued → failed（error_code / error_message 非空）；重复反推插新行',
        actual: `ids=${first}/${second} queued=${String(queuedRow.status)}→succeeded=${String(succeededRow.status)}（GET ${String(succeededDto.job.status)}） 产物=${typeof succeededRow.result_json}/${typeof succeededRow.result_prompt} failed=${String(failedRow.status)}/${String(failedRow.error_code)} 新行未动=${String(secondQueued.status)}`,
      };
    },
  },
);

// ── `tickets/T19` 实名、用户资料与生成门槛（`docs/prd/spec/07-验收标准.md` §2.10：API-09、RN-01–RN-04）──
// 进程内直调实名端点与 `createGeneration`；每个用例自带清理（用户行 + 会话 + 审计行）。

/** 格式合法、校验位正确的四个样本（`11010519491231002X` 是 GB 11643 的公开样例）；每个用例各用一个，互不撞唯一性。 */
const REALNAME_ID_A = '11010519491231002X';
const REALNAME_ID_B = '310101199001011234';
const REALNAME_ID_C = '440305198506200074';
const REALNAME_ID_D = '330102198803150012';

let unverifiedSeq = 0;

/** 建一个**未实名**用户（`verified_at IS NULL`）并登记清理；手机号按序号保证唯一。 */
const makeUnverifiedUser = (): number => {
  unverifiedSeq += 1;
  const user = insertUser({
    phone: `1390001${String(1000 + unverifiedSeq).padStart(4, '0')}`,
    email: null,
    nickname: `验收用户${unverifiedSeq}`,
    createdAt: nowIso(),
  });
  cleanups.push(() => {
    getDb().prepare('DELETE FROM audit_logs WHERE user_id = ?').run(user.id);
    getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    getDb().prepare('DELETE FROM users WHERE id = ?').run(user.id);
  });
  return user.id;
};

const realnamePost = (userId: number, payload: unknown): Promise<Response> =>
  postRealName(
    requestWithUser(userId, 'http://localhost/api/me/realname', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({}) },
  );

const realnameGet = (userId: number): Promise<Response> =>
  getRealName(requestWithUser(userId, 'http://localhost/api/me/realname'), { params: Promise.resolve({}) });

const realnameRow = (
  userId: number,
): { realName: string | null; idHash: string | null; verifiedAt: string | null; raw: string } => {
  const row = getDb()
    .prepare('SELECT real_name, id_hash, verified_at FROM users WHERE id = ?')
    .get(userId) as { real_name: string | null; id_hash: string | null; verified_at: string | null };
  return { realName: row.real_name, idHash: row.id_hash, verifiedAt: row.verified_at, raw: JSON.stringify(row) };
};

const realnameAuditCount = (userId: number): number =>
  (getDb()
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.realname' AND user_id = ?")
    .get(userId) as { n: number }).n;

const errorFields = async (res: Response): Promise<{ code: string; keys: string[] }> => {
  const body = (await res.json()) as { error?: { code?: string; details?: { fields?: Record<string, unknown> } } };
  return { code: body.error?.code ?? '', keys: Object.keys(body.error?.details?.fields ?? {}).sort() };
};

checks.push(
  {
    id: 'RN-01',
    run: async () => {
      const userId = makeUnverifiedUser();
      const anchorId = makeReadyAnchor(); // 锚点本身可生成，门槛必须是实名
      const before = count('generations');
      const code = await codeOfCreate(() => createFor(anchorId, 2, userId));
      const after = count('generations');
      return {
        ok: code === 'REALNAME_REQUIRED' && after === before,
        expected: 'REALNAME_REQUIRED 且未产生 generations 行',
        actual: `${code}，generations ${before}→${after}`,
      };
    },
  },
  {
    id: 'RN-02',
    run: async () => {
      const userId = makeUnverifiedUser();
      const created = await realnamePost(userId, { realName: '张三', idNumber: REALNAME_ID_A.toLowerCase() });
      const row = realnameRow(userId);
      const expectedHash = createHash('sha256').update(REALNAME_ID_A, 'utf8').digest('hex');
      // 重提同一证件号（唯一性冲突被拒）后，已落的哈希逐字符不变 ⇒ 同一输入恒得同一哈希。
      await realnamePost(userId, { realName: '张三', idNumber: REALNAME_ID_A });
      const after = realnameRow(userId);
      return {
        ok:
          created.status === 200 &&
          row.idHash === expectedHash &&
          row.idHash !== REALNAME_ID_A &&
          !row.raw.includes(REALNAME_ID_A) &&
          after.idHash === row.idHash &&
          after.verifiedAt === row.verifiedAt,
        expected: 'id_hash = sha256(证件号) 且非明文；重提后不变',
        actual: `status=${created.status} hash=${row.idHash === expectedHash} 非明文=${!row.raw.includes(REALNAME_ID_A)} 重提后不变=${after.idHash === row.idHash}`,
      };
    },
  },
  {
    id: 'RN-03',
    run: async () => {
      const owner = makeUnverifiedUser();
      const other = makeUnverifiedUser();
      const first = await realnamePost(owner, { realName: '张三', idNumber: REALNAME_ID_B });
      const before = realnameRow(other);
      const second = await realnamePost(other, { realName: '李四', idNumber: REALNAME_ID_B });
      const fields = await errorFields(second);
      return {
        ok:
          first.status === 200 &&
          second.status === 400 &&
          fields.code === 'INVALID_PARAM' &&
          fields.keys.join(',') === 'idNumber' &&
          realnameRow(other).raw === before.raw,
        expected: '同一证件号二次实名 → 400 INVALID_PARAM（fields.idNumber），第二行不写',
        actual: `首选=${first.status} 二次=${second.status}/${fields.code} fields=${fields.keys.join(',')} 第二行未变=${realnameRow(other).raw === before.raw}`,
      };
    },
  },
  {
    id: 'RN-04',
    run: async () => {
      const userId = makeUnverifiedUser();
      const before = realnameAuditCount(userId);
      const ok = await realnamePost(userId, { realName: '张三', idNumber: REALNAME_ID_C });
      const row = realnameRow(userId);
      const auditCount = realnameAuditCount(userId);
      const audit = getDb()
        .prepare("SELECT target, created_at FROM audit_logs WHERE action = 'auth.realname' AND user_id = ?")
        .get(userId) as { target: string; created_at: string } | undefined;
      // 校验失败（格式 + 唯一性）都不写审计。
      await realnamePost(userId, { realName: '张3', idNumber: '123' });
      const failed = await realnamePost(userId, { realName: '张三', idNumber: REALNAME_ID_C });
      const afterFailed = realnameAuditCount(userId);
      return {
        ok:
          ok.status === 200 &&
          before === 0 &&
          auditCount === 1 &&
          audit?.target === `user:${userId}` &&
          audit?.created_at === row.verifiedAt &&
          failed.status === 400 &&
          afterFailed === 1,
        expected: "成功后恰 1 行 auth.realname（target=user:{id}，与 verified_at 同时刻）；校验失败不写",
        actual: `status=${ok.status} 审计 ${before}→${auditCount}（失败后仍 ${afterFailed}）target=${String(audit?.target)} 同时刻=${audit?.created_at === row.verifiedAt}`,
      };
    },
  },
  {
    id: 'API-09',
    run: async () => {
      const userId = makeUnverifiedUser();
      const fresh = await realnameGet(userId);
      const freshBody = (await fresh.json()) as { realNameStatus: Record<string, unknown> };
      const bad = await realnamePost(userId, { realName: '', idNumber: '' });
      const badFields = await errorFields(bad);
      const wrongFormat = await realnamePost(userId, { realName: '张三', idNumber: '123' });
      const wrongFields = await errorFields(wrongFormat);
      const ok = await realnamePost(userId, { realName: '张三', idNumber: REALNAME_ID_D });
      const okRaw = JSON.stringify(await ok.json());
      const after = await realnameGet(userId);
      const afterBody = (await after.json()) as { realNameStatus: { verified?: boolean; realName?: string; verifiedAt?: string | null } };
      const leaks = ['id_hash', 'real_name', 'verified_at', REALNAME_ID_D].filter((needle) =>
        okRaw.includes(needle),
      );
      return {
        ok:
          fresh.status === 200 &&
          Object.keys(freshBody).join(',') === 'realNameStatus' &&
          Object.keys(freshBody.realNameStatus).sort().join(',') === 'realName,verified,verifiedAt' &&
          freshBody.realNameStatus.verified === false &&
          freshBody.realNameStatus.verifiedAt === null &&
          freshBody.realNameStatus.realName === null &&
          bad.status === 400 &&
          badFields.code === 'INVALID_PARAM' &&
          badFields.keys.join(',') === 'idNumber,realName' &&
          wrongFormat.status === 400 &&
          wrongFields.keys.join(',') === 'idNumber' &&
          ok.status === 200 &&
          after.status === 200 &&
          afterBody.realNameStatus.verified === true &&
          afterBody.realNameStatus.realName === '张三' &&
          typeof afterBody.realNameStatus.verifiedAt === 'string' &&
          leaks.length === 0,
        expected:
          'GET 未实名 {verified:false,verifiedAt:null,realName:null}；POST 成功 200 且响应无证件号明文与三个列名；空值 / 格式错 → 400 fields',
        actual: `GET=${fresh.status} 键=${Object.keys(freshBody.realNameStatus).sort().join(',')} 空值=${bad.status}/${badFields.keys.join(',')} 格式=${wrongFormat.status}/${wrongFields.keys.join(',')} POST=${ok.status} 已实名=${String(afterBody.realNameStatus.verified)} 泄漏=${leaks.join(',') || '(无)'}`,
      };
    },
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