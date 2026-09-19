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
import type { ZodTypeAny } from 'zod';
import sharp from 'sharp';
import { getDb } from '../src/server/db/connection';
import { hardDeleteAnchor, insert as insertAnchor } from '../src/server/db/repositories/anchors';
import { getEra, getProfile, getScene, readEraSceneConfig } from '../src/server/db/repositories/config';
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
  anchorSchema,
  eraSceneConfigSchema,
  generationResultSchema,
  generationSchema,
  healthSchema,
  photoListSchema,
  photoSchema,
  qualitySchema,
  quotaSchema,
  realNameStatusSchema,
  userSchema,
} from '../src/shared/types';
import { ERROR_MESSAGE } from '../src/shared/error-message';
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
import { anchorExtractHandler } from '../src/jobs/handlers/anchorExtract';
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
import { POST as postLogin } from '../app/api/auth/login/route';
import { POST as postLogout } from '../app/api/auth/logout/route';
import { GET as getPhotos, POST as postPhoto } from '../app/api/photos/route';
import { GET as getRealName, POST as postRealName } from '../app/api/me/realname/route';
import { POST as postPreprocess } from '../app/api/photos/[id]/preprocess/route';
import { POST as postAnchor } from '../app/api/anchors/route';
import { DELETE as deleteAnchorRoute, GET as getAnchor } from '../app/api/anchors/[id]/route';
import { POST as postAnchorRetry } from '../app/api/anchors/[id]/retry/route';
import { POST as postConfirm } from '../app/api/anchors/[id]/confirm/route';
import { POST as postGeneration } from '../app/api/generations/route';
import { GET as getGeneration } from '../app/api/generations/[id]/route';
import { POST as postGenerationRetry } from '../app/api/generations/[id]/retry/route';
import { POST as postFeedback } from '../app/api/results/[id]/feedback/route';

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

/** 以指定用户身份构造进程内请求（受保护端点直调都带 `sid` cookie）。 */
const requestWithUser = (userId: number, url: string, init: RequestInit = {}): NextRequest => {
  const headers = new Headers(init.headers);
  headers.set('cookie', `${SID_COOKIE}=${cookieFor(userId)}`);
  return new Request(url, { ...init, headers }) as unknown as NextRequest;
};

/**
 * 已登录请求（`tickets/T12` 的真实会话）：懒建一条 `DEV_USER` 的会话，受保护端点的直调都带上 `sid` cookie；
 * 建行时登记清理（§3 的「自带清理」）。
 */
const authedRequest = (url: string, init: RequestInit = {}): NextRequest =>
  requestWithUser(DEV_USER, url, init);

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
      // 顺序即契约：把「未确认」的锚点给未实名用户，仍必须是 REALNAME_REQUIRED —— 实名先于
      // ANCHOR_NOT_CONFIRMED（409）与 CONSENT_REQUIRED（403）（`spec/03-接口契约.md` §3.5 第 1 步）。
      const unconfirmed = makeSucceededAnchor(); // confirmed_by_user 默认 0，且无 consents
      const precedence = await codeOfCreate(() => createFor(unconfirmed, 2, userId));
      const afterPrecedence = count('generations');
      return {
        ok: code === 'REALNAME_REQUIRED' && after === before && precedence === 'REALNAME_REQUIRED' && afterPrecedence === before,
        expected: 'REALNAME_REQUIRED 且未产生 generations 行；顺序在 ANCHOR_NOT_CONFIRMED / CONSENT_REQUIRED 之前',
        actual: `${code}（generations ${before}→${after}）；未确认锚点=${precedence}（generations ${before}→${afterPrecedence}）`,
      };
    },
  },
  {
    id: 'RN-02',
    run: async () => {
      const userId = makeUnverifiedUser();
      // 用小写写法提交：归一化后应与大写样例同一哈希（同一个证件号恒得同一个 id_hash）。
      const created = await realnamePost(userId, { realName: '张三', idNumber: REALNAME_ID_A.toLowerCase() });
      const row = realnameRow(userId);
      const expectedHash = createHash('sha256').update(REALNAME_ID_A, 'utf8').digest('hex');
      // 同一个用户重提同一证件号（另一种大小写写法）：幂等——哈希与实名时间都不动，也不是新的一次实名。
      const again = await realnamePost(userId, { realName: '张三', idNumber: REALNAME_ID_A });
      const after = realnameRow(userId);
      const audits = realnameAuditCount(userId);
      return {
        ok:
          created.status === 200 &&
          again.status === 200 &&
          row.idHash === expectedHash &&
          row.idHash !== REALNAME_ID_A &&
          !row.raw.includes(REALNAME_ID_A) &&
          after.raw === row.raw &&
          audits === 1,
        expected: 'id_hash = sha256(归一化后的证件号) 且非明文；重提同一证件号得同一哈希、不改写',
        actual: `首次=${created.status} 重提=${again.status} hash=${row.idHash === expectedHash} 非明文=${!row.raw.includes(REALNAME_ID_A)} 重提后整行不变=${after.raw === row.raw} 审计=${audits}`,
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
      // 校验失败（格式）不写审计，也不动已落的三列。
      await realnamePost(userId, { realName: '张3', idNumber: '123' });
      const afterFailed = realnameAuditCount(userId);
      const rowAfterFailed = realnameRow(userId);

      // 同一事务：让审计那一笔必然失败（临时触发器），`users` 三列必须一起回滚。
      const rollbackUser = makeUnverifiedUser();
      getDb().exec(
        `CREATE TEMP TRIGGER t19_fail_audit BEFORE INSERT ON audit_logs
         WHEN NEW.action = 'auth.realname' BEGIN SELECT RAISE(ABORT, 'T19 injected'); END;`,
      );
      let injected: Response;
      const originalError = console.error;
      console.error = () => undefined; // 注入的失败由 `withErrorHandling` 记一条 unhandled error，这里不必打进验收输出
      try {
        injected = await realnamePost(rollbackUser, { realName: '张三', idNumber: REALNAME_ID_D });
      } finally {
        console.error = originalError;
        getDb().exec('DROP TRIGGER t19_fail_audit');
      }
      const rolledBack = realnameRow(rollbackUser);
      return {
        ok:
          ok.status === 200 &&
          before === 0 &&
          auditCount === 1 &&
          audit?.target === `user:${userId}` &&
          audit?.created_at === row.verifiedAt &&
          afterFailed === 1 &&
          rowAfterFailed.raw === row.raw &&
          injected.status === 500 &&
          rolledBack.realName === null &&
          rolledBack.idHash === null &&
          rolledBack.verifiedAt === null,
        expected:
          "成功后恰 1 行 auth.realname（target=user:{id}，与 verified_at 同时刻）；校验失败不写；审计写失败时 users 三列一起回滚（同一事务）",
        actual: `status=${ok.status} 审计 ${before}→${auditCount}（失败后仍 ${afterFailed}）target=${String(audit?.target)} 同时刻=${audit?.created_at === row.verifiedAt} 失败未动库=${rowAfterFailed.raw === row.raw}；注入失败=${injected.status} 三列回滚=${rolledBack.realName === null && rolledBack.idHash === null && rolledBack.verifiedAt === null}`,
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
      // 请求字段名即契约：缺字段 / 非字符串 / 换错键名都必须被点上名（`spec/03-接口契约.md` §3.1）。
      const missing = await realnamePost(userId, {});
      const missingFields = await errorFields(missing);
      const wrongType = await realnamePost(userId, { realName: 123, idNumber: null });
      const wrongTypeFields = await errorFields(wrongType);
      const wrongKeys = await realnamePost(userId, { name: '张三', id: REALNAME_ID_D });
      const wrongKeysFields = await errorFields(wrongKeys);
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
          missing.status === 400 &&
          missingFields.keys.join(',') === 'idNumber,realName' &&
          wrongType.status === 400 &&
          wrongTypeFields.keys.join(',') === 'idNumber,realName' &&
          wrongKeys.status === 400 &&
          wrongKeysFields.keys.join(',') === 'idNumber,realName' &&
          ok.status === 200 &&
          after.status === 200 &&
          afterBody.realNameStatus.verified === true &&
          afterBody.realNameStatus.realName === '张三' &&
          typeof afterBody.realNameStatus.verifiedAt === 'string' &&
          leaks.length === 0,
        expected:
          'GET 未实名 {verified:false,verifiedAt:null,realName:null}；POST 成功 200 且响应无证件号明文与三个列名；空值 / 格式错 / 缺字段 / 非字符串 / 换键名 → 400 且 details.fields 点名契约字段',
        actual: `GET=${fresh.status} 键=${Object.keys(freshBody.realNameStatus).sort().join(',')} 空值=${bad.status}/${badFields.keys.join(',')} 格式=${wrongFormat.status}/${wrongFields.keys.join(',')} 缺字段=${missingFields.keys.join(',')} 非字符串=${wrongTypeFields.keys.join(',')} 换键名=${wrongKeysFields.keys.join(',')} POST=${ok.status} 已实名=${String(afterBody.realNameStatus.verified)} 泄漏=${leaks.join(',') || '(无)'}`,
      };
    },
  },
);

// ── `tickets/T15` 完整链路的后端段（`docs/prd/spec/07-验收标准.md` §2.4：E2E-01）──
// 前端段（上传 → 身份确认界面）由 A 层组件测试覆盖（`docs/prd/pages/P01-上传与身份确认.md` §7），
// 本检查只跑 API 链路：上传真实样例 → preprocess → 建锚点 → 提取 → confirm →
// 生成 E4×S3 count=2 → 跑生成 handler → 历史可见 → 下载可读；自带清理见 §3。

/** `E2E-01` 的输入样本（`docs/prd/spec/07-验收标准.md` §2.4；可用性已由 `PRE-09` 标定）。 */
const E2E_SAMPLE_PHOTO = 'docs/老照片/1b26e45303c7321fa589d4525b43aa0.jpg';

/** 删掉本次链路新建的 `photos` 行与磁盘文件（含上传阶段写过审核行的原图）。 */
const purgePhotos = (ids: number[]): void => {
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

/** 本次运行内新建的行 id：`newIds(table, 跑之前的 id 集合)`（`E2E-10` / `API-02` 的残留断言与清理共用）。 */
const newIds = (table: 'photos' | 'identity_anchors' | 'generations', before: Set<number>): number[] =>
  (getDb().prepare(`SELECT id FROM ${table}`).all() as { id: number }[])
    .map((row) => row.id)
    .filter((id) => !before.has(id));

/**
 * `E2E-01` / `E2E-02` / `E2E-10` 共用的链路驱动（`spec/07-验收标准.md` §2.4）：真实样例 → 上传 → 预处理
 * → 建锚点 → 提取 → 确认 → 生成 → 复核 → 历史 → 下载，**全程只走端点与 handler，不手工改库**。
 * 返回步骤串 / 问题串与本次新建的行 id（供 `E2E-10` 的残留断言），清理登记进 `cleanups`（§3，幂等）。
 */
interface SampleChain {
  anchorId: number | null;
  generationId: number | null;
  anchorText: string;
  steps: string[];
  problems: string[];
  newAnchorIds: number[];
  newGenerationIds: number[];
}

const driveSampleChain = async (keepRowsUntilEnd = false): Promise<SampleChain> => {
  // 生成链路的额度预扣会撞满 DEV_USER 的默认上限（T09/T10 的用例不回收），先抬高上限并快照回滚。
  raiseQuotaForGenerationChecks();
  snapshotUsage();

  const photosBefore = new Set(
    (getDb().prepare('SELECT id FROM photos').all() as { id: number }[]).map((row) => row.id),
  );
  const generationsBefore = new Set(
    (getDb().prepare('SELECT id FROM generations').all() as { id: number }[]).map((row) => row.id),
  );
  const anchorsBefore = new Set(
    (getDb().prepare('SELECT id FROM identity_anchors').all() as { id: number }[]).map((row) => row.id),
  );

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const id of newIds('generations', generationsBefore)) purgeGeneration(id);
    for (const id of newIds('identity_anchors', anchorsBefore)) {
      getDb().prepare('DELETE FROM consents WHERE anchor_id = ?').run(id);
      getDb().prepare('DELETE FROM audit_logs WHERE target = ?').run(`anchor:${id}`);
      hardDeleteAnchor(id, DEV_USER);
    }
    purgePhotos(newIds('photos', photosBefore));
  };
  cleanups.push(cleanup);

  const problems: string[] = [];
  const steps: string[] = [];
  let anchorId: number | null = null;
  let generationId: number | null = null;
  let anchorText = '';
  const outcome = (): SampleChain => ({
    anchorId,
    generationId,
    anchorText,
    steps,
    problems,
    newAnchorIds: newIds('identity_anchors', anchorsBefore),
    newGenerationIds: newIds('generations', generationsBefore),
  });

    try {
      // ① 登入：DEV_USER 的会话（种子已实名，`migrations/001-init.sql`），受保护端点都带 `sid` cookie。
      const me = await getMe(authedRequest('http://localhost/api/me'), { params: Promise.resolve({}) });
      steps.push(`登入=${me.status}`);
      if (me.status !== 200) {
        problems.push(`登入返回 ${me.status}`);
        return outcome();
      }

      // ② 上传真实样例（`multipart/form-data`，字段 `file`）。
      const bytes = fs.readFileSync(E2E_SAMPLE_PHOTO);
      const form = new FormData();
      form.set('file', new File([new Uint8Array(bytes)], path.basename(E2E_SAMPLE_PHOTO), { type: 'image/jpeg' }));
      const uploadRes = await postPhoto(
        authedRequest('http://localhost/api/photos', { method: 'POST', body: form }),
        { params: Promise.resolve({}) },
      );
      const originalId = ((await uploadRes.json()) as { photo?: { id?: number } }).photo?.id;
      steps.push(`上传=${uploadRes.status}`);
      if (uploadRes.status !== 201 || originalId === undefined) {
        problems.push(`上传失败 ${uploadRes.status}`);
        return outcome();
      }

      // ③ 预处理（幂等；`usable=false` 也 200，但锚点提取会判低质量 → 这里必须可用）。
      const preRes = await postPreprocess(
        authedRequest(`http://localhost/api/photos/${originalId}/preprocess`, { method: 'POST' }),
        { params: Promise.resolve({ id: String(originalId) }) },
      );
      const preBody = (await preRes.json()) as { photo?: { id?: number }; quality?: { usable?: boolean } };
      steps.push(`preprocess=${preRes.status}/usable=${String(preBody.quality?.usable)}`);
      if (preRes.status !== 200 || preBody.photo?.id === undefined || preBody.quality?.usable !== true) {
        problems.push('预处理未产出可用图');
        return outcome();
      }

      // ④ 建锚点（`spec/03-接口契约.md` §3.3：`POST /api/anchors` 收 `photoIds`）。
      const anchorRes = await postAnchor(
        authedRequest('http://localhost/api/anchors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photoIds: [originalId] }),
        }),
        { params: Promise.resolve({}) },
      );
      const createdAnchor = ((await anchorRes.json()) as { anchor?: { id?: number; status?: string } }).anchor;
      anchorId = createdAnchor?.id ?? null;
      steps.push(`建锚点=${anchorRes.status}/${createdAnchor?.status ?? '-'}`);
      if (anchorRes.status !== 202 || anchorId === null) {
        problems.push(`建锚点失败 ${anchorRes.status}`);
        return outcome();
      }

      // ⑤ 轮询至 `succeeded`：进程内没有真实 worker（`spec/03` §2.1），直接跑该行的 handler 再读端点。
      const readAnchor = async (): Promise<{ status: string; anchorText: string | null }> => {
        const res = await getAnchor(authedRequest(`http://localhost/api/anchors/${anchorId}`), {
          params: Promise.resolve({ id: String(anchorId) }),
        });
        const anchor = ((await res.json()) as { anchor: { status: string; anchorText: string | null } }).anchor;
        return { status: anchor.status, anchorText: anchor.anchorText };
      };
      let anchorDto = await readAnchor();
      for (let tries = 0; tries < 5 && anchorDto.status !== 'succeeded' && anchorDto.status !== 'failed'; tries += 1) {
        await anchorExtractHandler({ anchorId });
        anchorDto = await readAnchor();
      }
      steps.push(`锚点=${anchorDto.status}`);
      if (anchorDto.status !== 'succeeded' || anchorDto.anchorText === null || anchorDto.anchorText === '') {
        problems.push(`锚点未到 succeeded（${anchorDto.status}）`);
        return outcome();
      }
      anchorText = anchorDto.anchorText;

      // ⑥ 确认（两项授权缺一不可，`modules/M04` §5.1）。
      const confirmRes = await postConfirm(
        authedRequest(`http://localhost/api/anchors/${anchorId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed: true, consents: ['photo_usage', 'family_agreement'] }),
        }),
        { params: Promise.resolve({ id: String(anchorId) }) },
      );
      steps.push(`confirm=${confirmRes.status}`);
      if (confirmRes.status !== 200) {
        problems.push(`确认失败 ${confirmRes.status}`);
        return outcome();
      }

      // ⑦ 生成 E4×S3 count=2。
      const genRes = await postGeneration(
        authedRequest('http://localhost/api/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ anchorId, eraCode: 'E4', sceneId: 3, count: 2 }),
        }),
        { params: Promise.resolve({}) },
      );
      const createdGeneration = ((await genRes.json()) as { generation?: { id?: number; status?: string } })
        .generation;
      generationId = createdGeneration?.id ?? null;
      steps.push(`生成=${genRes.status}/${createdGeneration?.status ?? '-'}`);
      if (genRes.status !== 202 || generationId === null) {
        problems.push(`建生成任务失败 ${genRes.status}`);
        return outcome();
      }

      // ⑧ 轮询至 `succeeded`：同上，直接跑生成 handler 再读端点。
      const readGeneration = async (): Promise<{ status: string; results: unknown[] }> => {
        const res = await getGeneration(authedRequest(`http://localhost/api/generations/${generationId}`), {
          params: Promise.resolve({ id: String(generationId) }),
        });
        const generation = ((await res.json()) as { generation: { status: string; results: unknown[] } })
          .generation;
        return { status: generation.status, results: generation.results };
      };
      let generationDto = await readGeneration();
      for (
        let tries = 0;
        tries < 5 && generationDto.status !== 'succeeded' && !['failed', 'partial'].includes(generationDto.status);
        tries += 1
      ) {
        const record = findGenerationById(generationId);
        if (record !== null) await runGenerateJob(record);
        generationDto = await readGeneration();
      }
      steps.push(`生成终态=${generationDto.status}/${generationDto.results.length} 张`);
      if (generationDto.status !== 'succeeded' || generationDto.results.length !== 2) {
        problems.push(`生成未到 succeeded 或结果不足 2 张（${generationDto.status}/${generationDto.results.length}）`);
      }

      // ⑨ 历史可见：该锚点与本次生成都要出现在 `/api/history`。
      const history = await readHistory();
      const item = history.items.find((entry) => entry.anchorId === anchorId);
      const generationVisible = item?.generations.some((generation) => generation.id === generationId) ?? false;
      steps.push(`历史可见=${item !== undefined}/${generationVisible}`);
      if (item === undefined) problems.push('历史里没有该锚点');
      else if (!generationVisible) problems.push('历史里没有本次生成');

      // ⑩ 下载：结果图（`kind='generated'`）走 `GET /api/photos/:id/file`，`sharp` 必须解析出宽高。
      const resultPhotoId = resultRows(generationId)[0]?.photo_id;
      if (resultPhotoId === undefined) {
        problems.push('没有结果图可下载');
        return outcome();
      }
      const fileRes = await getPhotoFile(
        authedRequest(`http://localhost/api/photos/${resultPhotoId}/file`),
        { params: Promise.resolve({ id: String(resultPhotoId) }) },
      );
      const meta = await sharp(Buffer.from(await fileRes.arrayBuffer())).metadata();
      steps.push(`下载=${fileRes.status}/${String(meta.width)}x${String(meta.height)}`);
      if (fileRes.status !== 200 || typeof meta.width !== 'number' || typeof meta.height !== 'number') {
        problems.push(`下载图不可读（${fileRes.status}/${String(meta.width)}x${String(meta.height)}）`);
      }

      return outcome();
    } finally {
      // 默认立即回收（幂等，`cleanups` 里那份是兜底），helper 中途抛错也不留行与盘上文件；
      // `keepRowsUntilEnd` 时留到 `main()` 结束前（`E2E-10` 要在链路结束后读新增行的终态）。
      if (!keepRowsUntilEnd) cleanup();
    }
  };

checks.push({
  id: 'E2E-01',
  run: async () => {
    const chain = await driveSampleChain();
    return {
      ok: chain.problems.length === 0,
      expected:
        '登入 → 上传样例 201 → preprocess → 建锚点 → 提取 succeeded → confirm → 生成 E4×S3 count=2 → succeeded(2 张) → 历史可见 → 下载图可解析宽高',
      actual:
        chain.problems.length === 0
          ? `全链路无错误；${chain.steps.join(' → ')}`
          : `${chain.problems.join('；')}；${chain.steps.join(' → ')}`,
    };
  },
});

// ── `tickets/T20` 最终验收收口：B 层最后 9 项（`docs/prd/spec/07-验收标准.md` §2）──
// `API-01` / `CMP-02` 是静态扫描；其余进程内直调端点 / handler，清理统一登记进 `cleanups`（§3）。

/**
 * `spec/03-接口契约.md` §3 的端点清单：静态解析文档，`API-01` 据此校验路由文件与方法导出。
 * 文档里的列表端点写作 ``**`GET /api/photos?cursor=<opaque>&limit=20`**``——按查询串前的路径去重，
 * 否则 `GET /api/history` / `GET /api/photos` 会被 `?` 漏掉（§2.3 要求「无缺失」）。
 */
const specEndpoints = (): { method: string; apiPath: string }[] => {
  const text = fs.readFileSync('docs/prd/spec/03-接口契约.md', 'utf8');
  const section = text.slice(text.indexOf('## 3. 端点详表'), text.indexOf('## 4. TypeScript 形状'));
  const found = new Map<string, { method: string; apiPath: string }>();
  const re = /\*\*`(GET|POST|DELETE|PATCH|PUT) (\/api\/[^`\s]+)`\*\*/g;
  for (const m of section.matchAll(re)) {
    const method = m[1];
    const rawPath = m[2];
    if (method === undefined || rawPath === undefined) continue;
    const apiPath = rawPath.split('?')[0] ?? rawPath;
    found.set(`${method} ${apiPath}`, { method, apiPath });
  }
  return [...found.values()].sort((a, b) =>
    `${a.method} ${a.apiPath}`.localeCompare(`${b.method} ${b.apiPath}`),
  );
};

/** 走 `POST /api/photos` 上传一张内存 jpeg 夹具，返回响应体里的 `photo`（行与磁盘文件由 `cleanups` 回收）。 */
const uploadFixturePhoto = async (): Promise<Record<string, unknown>> => {
  const buffer = await sharp({
    create: { width: 48, height: 48, channels: 3, background: { r: 205, g: 185, b: 160 } },
  })
    .jpeg()
    .toBuffer();
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buffer)], 'acceptance-shape.jpg', { type: 'image/jpeg' }));
  const res = await postPhoto(authedRequest('http://localhost/api/photos', { method: 'POST', body: form }), {
    params: Promise.resolve({}),
  });
  if (res.status !== 201) throw new Error(`上传夹具失败：${res.status}`);
  return ((await res.json()) as { photo: Record<string, unknown> }).photo;
};

/** 已实名用户（跨用户 404 用例要过第 1 步实名门槛）；行清理由 `makeUnverifiedUser` 登记。 */
const makeVerifiedUser = (): number => {
  const id = makeUnverifiedUser();
  getDb()
    .prepare('UPDATE users SET verified_at = ?, real_name = ?, id_hash = ? WHERE id = ?')
    .run(nowIso(), '验收用户', `acceptance-hash-${id}`, id);
  return id;
};

/** `API-02` 的 `POST /api/me/realname` 样本（GB 11643 校验位合法，且不与 `RN-01`–`RN-04` 的样本撞唯一性）。 */
const API02_REALNAME_ID = '530102198203150112';

checks.push(
  {
    // `API-01`（`spec/03-接口契约.md` §3）：§3 列出的每个端点都要有 `app/api/**/route.ts`，且导出对应方法。
    id: 'API-01',
    run: () => {
      const endpoints = specEndpoints();
      const missing: string[] = [];
      for (const { method, apiPath } of endpoints) {
        const file = `app${apiPath.replace(/:([A-Za-z]+)/g, '[$1]')}/route.ts`;
        if (!fs.existsSync(file)) {
          missing.push(`${method} ${apiPath}（缺 ${file}）`);
          continue;
        }
        if (!new RegExp(`export const ${method}\\b`).test(fs.readFileSync(file, 'utf8'))) {
          missing.push(`${method} ${apiPath}（${file} 未导出 ${method}）`);
        }
      }
      return {
        ok: missing.length === 0,
        expected: `${endpoints.length} 个端点全部存在且导出对应方法`,
        actual:
          missing.length === 0 ? `${endpoints.length}/${endpoints.length}` : `${missing.length} 缺失：${missing.join('；')}`,
      };
    },
  },
  {
    // `API-02`（`spec/03-接口契约.md` §4、`spec/07-验收标准.md` §2.3）：逐端点直调一次，用 `src/shared/types.ts`
    // 的 zod schema 解析成功响应——该文件是这些形状的唯一来源；无共享 schema 的端点（`{ ok: true }`、
    // `POST /api/auth/code` 的 `{ sent, expiresInSec, devCode? }`、二进制读图）按文档顶层键集 / 响应头断言。
    id: 'API-02',
    dependsOn: ['API-01'],
    run: async () => {
      const failures: string[] = [];
      let checked = 0;
      const parseWith = (label: string, schema: ZodTypeAny, value: unknown): void => {
        checked += 1;
        const result = schema.safeParse(value);
        if (!result.success) {
          const issue = result.error.issues[0];
          failures.push(`${label}：${(issue?.path ?? []).join('.')} ${issue?.message ?? 'schema 不符'}`);
        }
      };
      const expectKeys = (label: string, body: Record<string, unknown>, keys: string[]): void => {
        checked += 1;
        const actual = Object.keys(body).sort();
        const want = [...keys].sort();
        if (actual.join(',') !== want.join(',')) failures.push(`${label}：键=${actual.join(',')}，期望=${want.join(',')}`);
      };
      const expectStatus = (label: string, res: Response, status: number): void => {
        checked += 1;
        if (res.status !== status) failures.push(`${label}：HTTP ${res.status}，期望 ${status}`);
      };
      const finish = (): CheckResult => ({
        ok: failures.length === 0,
        expected: '全部端点的成功响应都能通过 src/shared/types.ts 的共享 schema（或文档顶层键集）校验',
        actual: failures.length === 0 ? `${checked} 项通过` : `${failures.length}/${checked} 项不符：${failures.join('；')}`,
      });

      // 自带清理：端点直调会写 `photos` / `identity_anchors` 行，按本次运行内的 id 列表回收。
      const photosBefore = new Set(
        (getDb().prepare('SELECT id FROM photos').all() as { id: number }[]).map((row) => row.id),
      );
      const anchorsBefore = new Set(
        (getDb().prepare('SELECT id FROM identity_anchors').all() as { id: number }[]).map((row) => row.id),
      );
      cleanups.push(() => {
        for (const id of newIds('identity_anchors', anchorsBefore)) {
          getDb().prepare('DELETE FROM consents WHERE anchor_id = ?').run(id);
          getDb().prepare('DELETE FROM audit_logs WHERE target = ?').run(`anchor:${id}`);
          hardDeleteAnchor(id, DEV_USER);
        }
        purgePhotos(newIds('photos', photosBefore));
      });

      // ① GET /api/health（免登录）
      const healthRes = await getHealth(healthRequest, { params: Promise.resolve({}) });
      expectStatus('GET /api/health', healthRes, 200);
      parseWith('GET /api/health', healthSchema, await healthRes.json());

      // ② POST /api/auth/code → ③ POST /api/auth/login（同 identifier；首次登录自动建用户，行按 identifier / id 回收）
      const identifier = `137${String(Date.now()).slice(-8)}`;
      const codeRes = await postAuthCode(jsonRequest('http://localhost/api/auth/code', { identifier }), {
        params: Promise.resolve({}),
      });
      const codeBody = (await codeRes.json()) as Record<string, unknown>;
      expectStatus('POST /api/auth/code', codeRes, 200);
      expectKeys('POST /api/auth/code', codeBody, ['sent', 'expiresInSec', 'devCode']);
      const loginRes = await postLogin(
        jsonRequest('http://localhost/api/auth/login', { identifier, code: codeBody.devCode ?? '' }),
        { params: Promise.resolve({}) },
      );
      const loginBody = (await loginRes.json()) as { user?: Record<string, unknown> };
      expectStatus('POST /api/auth/login', loginRes, 200);
      parseWith('POST /api/auth/login.user', userSchema, loginBody.user);
      const loginUserId = loginBody.user?.id;
      cleanups.push(() => {
        getDb().prepare('DELETE FROM login_codes WHERE identifier = ?').run(identifier);
        if (typeof loginUserId === 'number') {
          getDb().prepare('DELETE FROM audit_logs WHERE user_id = ?').run(loginUserId);
          getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(loginUserId);
          getDb().prepare('DELETE FROM users WHERE id = ?').run(loginUserId);
        }
      });

      // ④ POST /api/auth/logout（用一次性用户的会话，不动 `DEV_USER` 的会话）
      const logoutUser = makeUnverifiedUser();
      const logoutRes = await postLogout(
        requestWithUser(logoutUser, 'http://localhost/api/auth/logout', { method: 'POST' }),
        { params: Promise.resolve({}) },
      );
      expectStatus('POST /api/auth/logout', logoutRes, 200);
      expectKeys('POST /api/auth/logout', (await logoutRes.json()) as Record<string, unknown>, ['ok']);

      // ⑤ GET /api/me
      const meRes = await getMe(authedRequest('http://localhost/api/me'), { params: Promise.resolve({}) });
      const meBody = (await meRes.json()) as { user?: unknown; quota?: unknown };
      expectStatus('GET /api/me', meRes, 200);
      parseWith('GET /api/me.user', userSchema, meBody.user);
      parseWith('GET /api/me.quota', quotaSchema, meBody.quota);

      // ⑥ GET /api/me/realname → ⑦ POST /api/me/realname（未实名的一次性用户）
      const realnameUser = makeUnverifiedUser();
      const realnameGetRes = await realnameGet(realnameUser);
      const realnameGetBody = (await realnameGetRes.json()) as { realNameStatus?: unknown };
      expectStatus('GET /api/me/realname', realnameGetRes, 200);
      parseWith('GET /api/me/realname', realNameStatusSchema, realnameGetBody.realNameStatus);
      const realnamePostRes = await realnamePost(realnameUser, { realName: '王五', idNumber: API02_REALNAME_ID });
      const realnamePostBody = (await realnamePostRes.json()) as { realNameStatus?: unknown };
      expectStatus('POST /api/me/realname', realnamePostRes, 200);
      parseWith('POST /api/me/realname', realNameStatusSchema, realnamePostBody.realNameStatus);

      // ⑧ GET /api/config/era-scene
      parseWith('GET /api/config/era-scene', eraSceneConfigSchema, await readConfigResponse());

      // ⑨ POST /api/photos → ⑩ POST /api/photos/:id/preprocess → ⑪ GET /api/photos/:id/file
      const uploaded = await uploadFixturePhoto();
      parseWith('POST /api/photos', photoSchema, uploaded);
      const originalId = typeof uploaded.id === 'number' ? uploaded.id : null;
      if (originalId === null) {
        failures.push('POST /api/photos：响应缺 id，后续依赖照片的端点未校验');
        return finish();
      }
      const preRes = await postPreprocess(
        authedRequest(`http://localhost/api/photos/${originalId}/preprocess`, { method: 'POST' }),
        { params: Promise.resolve({ id: String(originalId) }) },
      );
      const preBody = (await preRes.json()) as { photo?: unknown; quality?: unknown };
      expectStatus('POST /api/photos/:id/preprocess', preRes, 200);
      parseWith('POST /api/photos/:id/preprocess.photo', photoSchema, preBody.photo);
      parseWith('POST /api/photos/:id/preprocess.quality', qualitySchema, preBody.quality);

      const fileRes = await getPhotoFile(authedRequest(`http://localhost/api/photos/${originalId}/file`), {
        params: Promise.resolve({ id: String(originalId) }),
      });
      checked += 1;
      const fileType = fileRes.headers.get('content-type') ?? '';
      const fileBytes = (await fileRes.arrayBuffer()).byteLength;
      if (fileRes.status !== 200 || !fileType.startsWith('image/') || fileBytes === 0) {
        failures.push(`GET /api/photos/:id/file：${fileRes.status}/${fileType}/${fileBytes}B`);
      }

      // ⑫ GET /api/photos（未呈现集，独立游标）
      const listRes = await getPhotos(authedRequest('http://localhost/api/photos'), { params: Promise.resolve({}) });
      expectStatus('GET /api/photos', listRes, 200);
      parseWith('GET /api/photos', photoListSchema, await listRes.json());

      // ⑬ POST /api/anchors → ⑭ GET /api/anchors/:id（改上传图建锚点，202 形状校验；跑到 succeeded
      // 的真实链路归 `E2E-01` / `E2E-10`，这里不重复驱动 extraction）
      const anchorRes = await postAnchor(
        authedRequest('http://localhost/api/anchors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photoIds: [originalId] }),
        }),
        { params: Promise.resolve({}) },
      );
      const anchorBody = (await anchorRes.json()) as { anchor?: { id?: number } };
      expectStatus('POST /api/anchors', anchorRes, 202);
      parseWith('POST /api/anchors', anchorSchema, anchorBody.anchor);
      const anchorId = anchorBody.anchor?.id ?? null;
      if (anchorId !== null) {
        const anchorGetRes = await getAnchor(authedRequest(`http://localhost/api/anchors/${anchorId}`), {
          params: Promise.resolve({ id: String(anchorId) }),
        });
        expectStatus('GET /api/anchors/:id', anchorGetRes, 200);
        parseWith('GET /api/anchors/:id', anchorSchema, ((await anchorGetRes.json()) as { anchor?: unknown }).anchor);
      }

      // ⑮ POST /api/anchors/:id/confirm（用 succeeded 夹具锚点，不依赖夹具图的质量评分）
      const confirmSeedAnchor = makeSucceededAnchor();
      const confirmRes = await postConfirm(
        authedRequest(`http://localhost/api/anchors/${confirmSeedAnchor}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed: true, consents: ['photo_usage', 'family_agreement'] }),
        }),
        { params: Promise.resolve({ id: String(confirmSeedAnchor) }) },
      );
      const confirmBody = (await confirmRes.json()) as { anchor?: unknown; consents?: unknown };
      expectStatus('POST /api/anchors/:id/confirm', confirmRes, 200);
      parseWith('POST /api/anchors/:id/confirm.anchor', anchorSchema, confirmBody.anchor);
      checked += 1;
      if (!Array.isArray(confirmBody.consents)) failures.push('POST /api/anchors/:id/confirm.consents 非数组');

      // ⑯ POST /api/anchors/:id/retry → ⑰ DELETE /api/anchors/:id（一次性锚点，不动链路锚点）
      const retrySeedAnchor = makeSucceededAnchor();
      const anchorRetryRes = await postAnchorRetry(
        authedRequest(`http://localhost/api/anchors/${retrySeedAnchor}/retry`, { method: 'POST' }),
        { params: Promise.resolve({ id: String(retrySeedAnchor) }) },
      );
      const anchorRetryBody = (await anchorRetryRes.json()) as { anchor?: { id?: number } };
      expectStatus('POST /api/anchors/:id/retry', anchorRetryRes, 202);
      parseWith('POST /api/anchors/:id/retry', anchorSchema, anchorRetryBody.anchor);
      const retriedAnchorId = anchorRetryBody.anchor?.id ?? null;
      if (retriedAnchorId !== null) {
        const deleteAnchorRes = await deleteAnchorRoute(
          authedRequest(`http://localhost/api/anchors/${retriedAnchorId}`, { method: 'DELETE' }),
          { params: Promise.resolve({ id: String(retriedAnchorId) }) },
        );
        expectStatus('DELETE /api/anchors/:id', deleteAnchorRes, 200);
        expectKeys('DELETE /api/anchors/:id', (await deleteAnchorRes.json()) as Record<string, unknown>, [
          'ok',
          'cascaded',
        ]);
      }

      // ⑱–㉒ 生成链路：POST → GET → 跑 handler → retry → feedback（用**盘上有文件**的夹具锚点，
      // 以便跑出结果行给 `POST /api/results/:id/feedback` 用）
      {
        raiseQuotaForGenerationChecks();
        snapshotUsage();
        const generationSeedAnchor = await makeGeneratableAnchor();
        const generationRes = await postGeneration(
          authedRequest('http://localhost/api/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ anchorId: generationSeedAnchor, eraCode: 'E4', sceneId: 3, count: 2 }),
          }),
          { params: Promise.resolve({}) },
        );
        const generationBody = (await generationRes.json()) as { generation?: { id?: number } };
        expectStatus('POST /api/generations', generationRes, 202);
        parseWith('POST /api/generations', generationSchema, generationBody.generation);
        const generationId = generationBody.generation?.id ?? null;
        if (generationId !== null) {
          cleanups.push(() => purgeGeneration(generationId));
          const generationGetRes = await getGeneration(
            authedRequest(`http://localhost/api/generations/${generationId}`),
            { params: Promise.resolve({ id: String(generationId) }) },
          );
          expectStatus('GET /api/generations/:id', generationGetRes, 200);
          parseWith(
            'GET /api/generations/:id',
            generationSchema,
            ((await generationGetRes.json()) as { generation?: unknown }).generation,
          );

          for (let tries = 0; tries < 5; tries += 1) {
            if (['succeeded', 'failed', 'partial'].includes(generationRow(generationId).status)) break;
            const record = findGenerationById(generationId);
            if (record !== null) await runGenerateJob(record);
          }

          const generationRetryRes = await postGenerationRetry(
            authedRequest(`http://localhost/api/generations/${generationId}/retry`, { method: 'POST' }),
            { params: Promise.resolve({ id: String(generationId) }) },
          );
          const generationRetryBody = (await generationRetryRes.json()) as { generation?: { id?: number } };
          expectStatus('POST /api/generations/:id/retry', generationRetryRes, 202);
          parseWith('POST /api/generations/:id/retry', generationSchema, generationRetryBody.generation);
          const retriedGenerationId = generationRetryBody.generation?.id;
          if (typeof retriedGenerationId === 'number') {
            // retry 产生的新行是非终态：必须**立刻**收回，否则它会挡住后续用例的排他检查
            // （`409 GENERATION_IN_PROGRESS`，`spec/03-接口契约.md` §3.5 第 8 步）。
            purgeGeneration(retriedGenerationId);
          }

          const firstResult = getDb()
            .prepare('SELECT id FROM generation_results WHERE generation_id = ? ORDER BY ordinal LIMIT 1')
            .get(generationId) as { id: number } | undefined;
          if (firstResult === undefined) {
            failures.push('POST /api/results/:id/feedback：链路生成没有结果行');
          } else {
            const feedbackRes = await postFeedback(
              authedRequest(`http://localhost/api/results/${firstResult.id}/feedback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ feedback: 1 }),
              }),
              { params: Promise.resolve({ id: String(firstResult.id) }) },
            );
            expectStatus('POST /api/results/:id/feedback', feedbackRes, 200);
            parseWith(
              'POST /api/results/:id/feedback',
              generationResultSchema,
              ((await feedbackRes.json()) as { result?: unknown }).result,
            );
          }
        }
      }

      // ㉓ GET /api/history
      const historyRes = await getHistory(authedRequest('http://localhost/api/history'), {
        params: Promise.resolve({}),
      });
      expectStatus('GET /api/history', historyRes, 200);
      parseWith('GET /api/history', historyListSchema, await historyRes.json());

      // ㉔ POST /api/prompt-reverse-jobs → ㉕ GET /api/prompt-reverse-jobs/:id
      const reverseRes = await reversePost({ photoId: originalId });
      const reverseBody = (await reverseRes.json()) as { job?: { id?: number } };
      expectStatus('POST /api/prompt-reverse-jobs', reverseRes, 202);
      parseWith('POST /api/prompt-reverse-jobs', promptReverseJobSchema, reverseBody.job);
      const jobId = reverseBody.job?.id ?? null;
      if (jobId !== null) {
        cleanups.push(() => getDb().prepare('DELETE FROM prompt_reverse_jobs WHERE id = ?').run(jobId));
        const reverseGetRes = await reverseGet(jobId);
        expectStatus('GET /api/prompt-reverse-jobs/:id', reverseGetRes, 200);
        parseWith(
          'GET /api/prompt-reverse-jobs/:id',
          promptReverseJobSchema,
          ((await reverseGetRes.json()) as { job?: unknown }).job,
        );
      }

      // ㉖ DELETE /api/photos/:id（最后删原图，级联软删链路派生物）
      const deletePhotoRes = await deletePhotoRoute(
        authedRequest(`http://localhost/api/photos/${originalId}`, { method: 'DELETE' }),
        { params: Promise.resolve({ id: String(originalId) }) },
      );
      expectStatus('DELETE /api/photos/:id', deletePhotoRes, 200);
      expectKeys('DELETE /api/photos/:id', (await deletePhotoRes.json()) as Record<string, unknown>, [
        'ok',
        'cascaded',
      ]);

      return finish();
    },
  },
  {
    // `API-04`（`spec/03-接口契约.md` §3.2 / §3.3 / §3.5、`modules/M01` §6.3、`modules/M08` §5）：跨用户
    // 访问一律 `404 NOT_FOUND`（不返回 403，避免用 403 泄漏「资源存在但不属于你」）。
    id: 'API-04',
    dependsOn: ['API-01'],
    run: async () => {
      raiseQuotaForGenerationChecks();
      snapshotUsage();
      const other = makeVerifiedUser();
      const anchorId = makeReadyAnchor();
      const generation = await createFor(anchorId, 2);
      cleanups.push(() => purgeGeneration(generation.id));
      const photoId = sharedPreprocessedPhoto();
      const probes: string[] = [];
      /** 每个探针都跑完再合并（不短路）：`code` 用契约里该端点对「不存在 / 他人资源」的专属错误码。 */
      const expect404 = async (label: string, res: Response, allowed: string[]): Promise<boolean> => {
        const code = await encodeErrorCode(res);
        probes.push(`${label}=${res.status}/${code}`);
        return res.status === 404 && allowed.includes(code);
      };
      // 判定顺序固定：先归属后权限（`modules/M04` §5.3）——锚点侧是 `ANCHOR_NOT_FOUND`，
      // 照片 / 生成侧共用 `NOT_FOUND`（不返回 403，`API-04`）。
      const notFound = ['NOT_FOUND'];
      const anchorNotFound = ['ANCHOR_NOT_FOUND', 'NOT_FOUND'];
      const anchorProbe = await getAnchor(
        requestWithUser(other, `http://localhost/api/anchors/${anchorId}`),
        { params: Promise.resolve({ id: String(anchorId) }) },
      );
      const generationProbe = await getGeneration(
        requestWithUser(other, `http://localhost/api/generations/${generation.id}`),
        { params: Promise.resolve({ id: String(generation.id) }) },
      );
      const fileProbe = await getPhotoFile(
        requestWithUser(other, `http://localhost/api/photos/${photoId}/file`),
        { params: Promise.resolve({ id: String(photoId) }) },
      );
      const deleteProbe = await deletePhotoRoute(
        requestWithUser(other, `http://localhost/api/photos/${photoId}`, { method: 'DELETE' }),
        { params: Promise.resolve({ id: String(photoId) }) },
      );
      const createProbe = await postGeneration(
        requestWithUser(other, 'http://localhost/api/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ anchorId, eraCode: 'E2', sceneId: 1, count: 2 }),
        }),
        { params: Promise.resolve({}) },
      );
      const results = [
        await expect404('GET /api/anchors/:id', anchorProbe, anchorNotFound),
        await expect404('GET /api/generations/:id', generationProbe, notFound),
        await expect404('GET /api/photos/:id/file', fileProbe, notFound),
        await expect404('DELETE /api/photos/:id', deleteProbe, notFound),
        await expect404('POST /api/generations', createProbe, anchorNotFound),
      ];
      const ok = results.every(Boolean);
      // 这一步为判定造了一条 `DEV_USER` 的生成行，立刻收回，避免挡住后续用例的排他检查。
      purgeGeneration(generation.id);
      return {
        ok,
        expected: '他人资源一律 404（不返回 403）：GET 锚点 / GET 生成 / 取图 / 删图 / 用他人锚点发起生成',
        actual: probes.join('  '),
      };
    },
  },
  {
    // `SEC-06`（`spec/03-接口契约.md` §3.3 校验顺序、`modules/M03` §5.3）：`kind='generated'` 的照片
    // 不能作为锚点提取输入（防链式自举），且必须**在任何写操作之前**拦下。
    id: 'SEC-06',
    run: async () => {
      const generatedPhotoId = insertGeneratedPhoto();
      const before = count('identity_anchors');
      const res = await postAnchor(
        authedRequest('http://localhost/api/anchors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photoIds: [generatedPhotoId] }),
        }),
        { params: Promise.resolve({}) },
      );
      const code = await encodeErrorCode(res);
      const after = count('identity_anchors');
      return {
        ok: res.status === 400 && code === 'INVALID_PARAM' && after === before,
        expected: '400 INVALID_PARAM 且不产生 identity_anchors 行',
        actual: `${res.status}/${code}，anchors ${before}→${after}`,
      };
    },
  },
  {
    // `ERR-03`（`modules/M06-生成编排.md` §5.8、`spec/08-本地开发指南.md` §5.1）：上游 `InvalidParameter`
    // （size 低于下限）→ `INTERNAL`、不可重试（`attempt` 不动），且**不把上游原文透给用户**。
    id: 'ERR-03',
    run: () =>
      withGeneration(2, async ({ id }) => {
        const provider = getArk() as MockArkProvider;
        provider.setFailure('invalid-size');
        try {
          await runGeneration(id);
          const row = generationRow(id);
          const res = await getGeneration(authedRequest(`http://localhost/api/generations/${id}`), {
            params: Promise.resolve({ id: String(id) }),
          });
          const body = (await res.json()) as { generation?: { error?: { code?: string; message?: string } } };
          const error = body.generation?.error ?? null;
          const leaked = JSON.stringify(body).includes('image size must be at least');
          return {
            ok:
              row.status === 'failed' &&
              row.error_code === 'INTERNAL' &&
              row.attempt === 0 &&
              error?.code === 'INTERNAL' &&
              error?.message === ERROR_MESSAGE.INTERNAL &&
              !leaked,
            expected: 'failed / INTERNAL / attempt=0、响应用通用文案且不含上游原文',
            actual: `${row.status}/${row.error_code}/attempt=${row.attempt}，error.message=${error?.message ?? '-'}，泄漏上游原文=${leaked}`,
          };
        } finally {
          provider.setFailure(null);
        }
      }),
  },
  {
    // `CMP-02`（`spec/06-合规与风控.md` §2 义务清单第 11 行 / §9.1、`spec/07-验收标准.md` §2.8）：静态扫描
    // `app/` / `components/` / `src/` 的源码文本（去注释后是「字符串字面量与 JSX 文本」的超集）。
    // 适用面是**用户可见文案**（§2 第 11 行的「全部用户可见文案」），故跳过测试文件（它们按约定枚举禁用词
    // 当负例）与 prompt 正文资产（`src/server/prompt/*` 的「不是修复照片」是给模型看的指令，不是用户可见文案）。
    id: 'CMP-02',
    run: () => {
      const banned = [
        '复活',
        '重生',
        '重获新生',
        '一键还原青春',
        '年轻时的样子',
        '完美的全家福',
        '太棒了',
        '奇迹',
        '惊喜',
        '修复',
        '逝者',
        '离开的人',
      ];
      // 单词边界：`data` / `start` 里的 `ta` 不算，只有作为独立词的 `ta` 命中（`pages/P00` §9.3 的 `让ta回来`）。
      const standaloneTa = /(?<![A-Za-z])ta(?![A-Za-z])/;
      // 只剥「行首或空白后的 `//`」与块注释：不误伤字符串里的 `//`（如 `https://`），
      // 也避免把 `'a//修复'` 这类字面量里的命中悄悄抹掉。
      const stripComments = (text: string): string =>
        text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/gm, '$1');
      const offenders: string[] = [];
      const scan = (dir: string): void => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scan(full);
            continue;
          }
          if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
          const rel = path.relative(process.cwd(), full).split(path.sep).join('/');
          if (rel.startsWith('src/server/prompt/')) continue;
          const text = stripComments(fs.readFileSync(full, 'utf8'));
          const hits = banned.filter((word) => text.includes(word));
          if (standaloneTa.test(text)) hits.push('ta');
          if (hits.length > 0) offenders.push(`${rel}(${hits.join('/')})`);
        }
      };
      for (const root of ['app', 'components', 'src']) scan(root);
      return {
        ok: offenders.length === 0,
        expected: '0 命中 `spec/06-合规与风控.md` §9.1 的禁用词',
        actual: offenders.length === 0 ? '0 命中' : `${offenders.length} 命中 ${offenders.join(',')}`,
      };
    },
  },
  {
    // `E2E-02`（`spec/07-验收标准.md` §2.4、`spec/01-领域模型与数据库.md` §3.5）：真实链路产出的
    // `identity_anchors.anchor_text` 非空且长度 ∈ 60–120 字符。
    id: 'E2E-02',
    run: async () => {
      const chain = await driveSampleChain();
      const length = Array.from(chain.anchorText).length;
      const chainNote = chain.problems.length === 0 ? '' : `（链路问题：${chain.problems.join('；')}）`;
      return {
        ok: length >= 60 && length <= 120,
        expected: 'anchor_text 非空且长度 ∈ 60–120 字符',
        actual: `${length} 字符${chainNote}`,
      };
    },
  },
  {
    // `E2E-03`（`spec/07-验收标准.md` §2.4、`modules/M05-年代场景配置与Prompt拼装.md` §8 用例③）：
    // `generations.prompt` 与 `buildPrompt(anchorText, era, scene, profile)` 的输出**逐字符相等**——
    // 用 `spec/05-Prompt工程.md` 的那个入口函数重算（不是 `createGeneration` 内部用过的包装），
    // 等价于断言落库值没有被二次加工。
    id: 'E2E-03',
    run: () =>
      withGeneration(2, async ({ id }) => {
        const row = getDb()
          .prepare('SELECT anchor_id, era_code, scene_id, prompt FROM generations WHERE id = ?')
          .get(id) as { anchor_id: number; era_code: string; scene_id: number; prompt: string };
        const anchor = getDb().prepare('SELECT anchor_text FROM identity_anchors WHERE id = ?').get(row.anchor_id) as
          | { anchor_text: string | null }
          | undefined;
        const era = getEra(row.era_code);
        const scene = getScene(row.scene_id);
        const anchorText = anchor?.anchor_text ?? '';
        if (era === null || scene === null || anchorText === '') {
          return { ok: false, expected: '与 buildPrompt 输出逐字符相等', actual: '取不到 era / scene / anchor_text' };
        }
        const expected = buildPrompt({
          anchorText,
          era,
          scene,
          profile: getProfile(row.era_code, row.scene_id),
        }).prompt;
        return {
          ok: row.prompt === expected,
          expected: 'generations.prompt 与 buildPrompt 输出逐字符相等',
          actual:
            row.prompt === expected
              ? `相等（${row.prompt.length} 字符）`
              : `不等（落库 ${row.prompt.length} / 重算 ${expected.length}）`,
        };
      }),
  },
  {
    // `E2E-10`（`spec/07-验收标准.md` §2.4）：整条「上传 → 预处理 → 锚点 → 确认 → 生成 → **复核** → 历史」
    // 在 mock 下闭环——生成全 `succeeded`、锚点 `succeeded`、结果张数与 `ordinal` 连续、每张都带复核标注、
    // 审核留痕齐全；「无手工改库」的机器化代理是 confirm / generation.create 审计齐全。
    id: 'E2E-10',
    run: async () => {
      // 链路结束后还要读新增行的终态，故把回收留到 `main()` 结束前（`cleanups`）。
      const chain = await driveSampleChain(true);
      if (chain.problems.length > 0 || chain.anchorId === null || chain.generationId === null) {
        return {
          ok: false,
          expected: '全链路闭环：无手工改库、无 failed / partial 残留',
          actual: chain.problems.join('；') || '链路未产出锚点 / 生成',
        };
      }
      const anchorStatuses = chain.newAnchorIds.map(
        (id) =>
          (getDb().prepare('SELECT status FROM identity_anchors WHERE id = ?').get(id) as { status: string } | undefined)
            ?.status ?? 'missing',
      );
      const generationStatuses = chain.newGenerationIds.map((id) => generationRow(id).status);
      const results = resultRows(chain.generationId);
      // 复核（软标注，`modules/M07` §5.3）：每张结果都带 `era_check_json.verdict`，并留下 `stage='result'` 审核行。
      const reviewRows = getDb()
        .prepare('SELECT era_check_json FROM generation_results WHERE generation_id = ? ORDER BY ordinal')
        .all(chain.generationId) as { era_check_json: string | null }[];
      const eraChecked = reviewRows.filter((row) => {
        if (row.era_check_json === null) return false;
        try {
          const parsed = JSON.parse(row.era_check_json) as { verdict?: string };
          return ['pass', 'review', 'reject'].includes(parsed.verdict ?? '');
        } catch {
          return false;
        }
      }).length;
      const resultReviews = contentReviewRows(chain.generationId, 'result').length;
      const confirmAudit = (
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'anchor.confirm' AND target = ?")
          .get(`anchor:${chain.anchorId}`) as { n: number }
      ).n;
      const createAudit = (
        getDb()
          .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'generation.create' AND target = ?")
          .get(`generation:${chain.generationId}`) as { n: number }
      ).n;
      const ok =
        generationStatuses.every((status) => status === 'succeeded') &&
        anchorStatuses.every((status) => status === 'succeeded') &&
        results.length === 2 &&
        results.every((row, index) => row.ordinal === index) &&
        eraChecked === reviewRows.length &&
        reviewRows.length === results.length &&
        resultReviews >= 1 &&
        confirmAudit >= 1 &&
        createAudit >= 1;
      return {
        ok,
        expected:
          '全链路闭环：生成全部 succeeded、锚点 succeeded、结果 2 张且 ordinal 连续、每张带复核标注、有 stage=result 审核行、confirm / generation.create 审计齐全',
        actual: `生成 ${generationStatuses.join(',') || '(无)'}、锚点 ${anchorStatuses.join(',') || '(无)'}、结果 ${results.length} 张、复核标注 ${eraChecked}/${reviewRows.length}、result 审核 ${resultReviews}、confirm 审计 ${confirmAudit}、create 审计 ${createAudit}`,
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