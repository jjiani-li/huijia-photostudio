import type { Anchor, EraSceneProfile } from '../../src/shared/types';
import type { ReverseSuggestion } from '../../src/shared/reverse-suggestion';

/**
 * `/choose/[anchorId]` 的选择逻辑（`docs/prd/pages/P02-年代与场景选择.md` §7、§10）：
 * URL 参数的读写、低置信判据、提交按钮的置灰判据与守卫判据，全部是可测的纯函数，不依赖 React / 网络。
 *
 * 选择是**流程事实源**：写在查询参数上（`docs/prd/pages/P00-设计基准与路由.md` §6），一律 `router.replace`。
 */

/** 生成张数（`docs/prd/spec/03-接口契约.md` §3.5：2–4）。 */
export type Count = 2 | 3 | 4;

export const COUNTS: readonly Count[] = [2, 3, 4];

/** 不传 `count` 时服务端缺省 2（`spec/03-接口契约.md` §3.5）。 */
export const DEFAULT_COUNT: Count = 2;

export interface Selection {
  /** 年代代号（`eras.code`，`E1`–`E4`）；未选为 `null`。 */
  eraCode: string | null;
  /** **`scenes.id` 整数**，不是 `S1` 这类代号（`pages/P00` §6）；未选为 `null`。 */
  sceneId: number | null;
  count: Count;
}

/** `URLSearchParams` 与 Next 的 `ReadonlyURLSearchParams` 都满足的最小形状。 */
export interface SearchParamsLike {
  get(name: string): string | null;
}

const ERA_CODE_RE = /^E\d+$/;

/**
 * 读 `?era` / `?scene` / `?count`（`pages/P02` §10）：非法值一律回退、不抛。
 * 这里只做**形状**校验（年代是不是代号、场景是不是正整数）；代号是否真实存在由 `config.eras` 决定，
 * 选择页再把 URL 里的值对一遍配置表（见 `choose-panel.tsx` 的 `matchSelection`）。
 */
export const readSelection = (params: SearchParamsLike): Selection => {
  const rawEra = (params.get('era') ?? '').trim().toUpperCase();
  const rawScene = (params.get('scene') ?? '').trim();
  const rawCount = Number(params.get('count'));

  const sceneId = /^\d+$/.test(rawScene) ? Number(rawScene) : Number.NaN;
  return {
    eraCode: ERA_CODE_RE.test(rawEra) ? rawEra : null,
    sceneId: Number.isInteger(sceneId) && sceneId > 0 ? sceneId : null,
    count: (COUNTS as readonly number[]).includes(rawCount) ? (rawCount as Count) : DEFAULT_COUNT,
  };
};

/** 未提交的选择写回 URL（`router.replace`）；`count` 等于缺省 2 时不写（服务端缺省 2）。 */
export const writeSelection = (pathname: string, selection: Selection): string => {
  const params = new URLSearchParams();
  if (selection.eraCode !== null) params.set('era', selection.eraCode);
  if (selection.sceneId !== null) params.set('scene', String(selection.sceneId));
  if (selection.count !== DEFAULT_COUNT) params.set('count', String(selection.count));
  const query = params.toString();
  return query === '' ? pathname : `${pathname}?${query}`;
};

/**
 * 低置信判据（`pages/P02` §5、`modules/M05-年代场景配置与Prompt拼装.md` §6）：
 * `confidence < threshold` 才提示，**等于阈值不提示**；`profile === null` 不提示也不推断。
 * 阈值取响应里的 `confidenceHintThreshold`，不写死。
 */
export const isLowConfidence = (profile: EraSceneProfile | null, threshold: number): boolean =>
  profile !== null && profile.confidence < threshold;

/** 提交按钮的置灰原因；`null` 表示可发起生成。 */
export type GenerateGate = 'busy' | 'incomplete' | 'quota' | null;

export interface GateInput {
  eraCode: string | null;
  sceneId: number | null;
  /** `GET /api/me` 的 `quota.remaining`；`null` = 还没取到，此时不按额度置灰（服务端是唯一裁判）。 */
  remaining: number | null;
  count: Count;
  /** `POST /api/generations` 请求进行中（该端点非幂等，`spec/03` §1.5）。 */
  busy: boolean;
}

/** 优先级：请求进行中 → 未选完 → 额度不足（`pages/P02` §7）。 */
export const generateGate = (input: GateInput): GenerateGate => {
  if (input.busy) return 'busy';
  if (input.eraCode === null || input.sceneId === null) return 'incomplete';
  if (input.remaining !== null && input.remaining < input.count) return 'quota';
  return null;
};

/** 置灰时的逐字文案（`pages/P02` §7）；表驱动穷尽，新增 gate 由类型检查拦下，无兜底分支。 */
export const GATE_COPY: Record<Exclude<GenerateGate, null>, string> = {
  busy: '正在生成，大概要等一会儿',
  incomplete: '上面先各选一个',
  quota: '今天的额度不够了',
};

export const disabledReason = (input: GateInput): string | null => {
  const gate = generateGate(input);
  return gate === null ? null : GATE_COPY[gate];
};

/** 额度不足时的第二行（`pages/P02` §7，只在该 gate 下渲染）。 */
export const quotaHint = (remaining: number): string => `今天还能生成 ${remaining} 张`;

/** `POST /api/generations` 的请求体（`docs/prd/spec/03-接口契约.md` §3.5）。 */
export interface GenerationRequest {
  anchorId: number;
  eraCode: string;
  sceneId: number;
  count: Count;
}

export interface StartGenerationInput extends GateInput {
  anchorId: number;
  /** 注入的 `POST /api/generations`（真实现是 `apiRequest`），便于断言「置灰时不发起」。 */
  post: (body: GenerationRequest) => Promise<{ generation: { id: number } }>;
}

export type StartGenerationResult =
  | { started: true; generationId: number }
  | { started: false; gate: Exclude<GenerateGate, null> };

/**
 * 发起生成（`pages/P02` §7、`pages/P00` §12）：**置灰时一个请求都不发**——判据与按钮的
 * `disabled` 同源（都走 `generateGate`），该端点非幂等、`await` 期间由调用方置 `busy` 禁用按钮
 * （`spec/03-接口契约.md` §1.5）。
 */
export const startGeneration = async (input: StartGenerationInput): Promise<StartGenerationResult> => {
  const gate = generateGate(input);
  if (gate !== null) return { started: false, gate };

  const { eraCode, sceneId, count } = input;
  // `generateGate` 已蕴含 gate === null 时两个 id 非空；这两行只为收窄类型。
  if (eraCode === null || sceneId === null) return { started: false, gate: 'incomplete' };

  const { generation } = await input.post({ anchorId: input.anchorId, eraCode, sceneId, count });
  return { started: true, generationId: generation.id };
};

/** 配置为空数组 = 种子未跑（`pages/P02` §3）。 */
export const EMPTY_CONFIG_COPY = '年代和场景还没准备好，先跑一次 pnpm seed。';

/**
 * 会话失效时跳登录并**保留 `next`**（`pages/P02` §8、`pages/P00` §5.1 规则 ③）：
 * 请求回 401 时（cookie 被清掉而布局的软守卫没拦住）跳过去，登录后回到当前页。
 */
export const loginPath = (pathname: string): string => `/login?next=${encodeURIComponent(pathname)}`;

/**
 * 任一取数回 `UNAUTHENTICATED` 即视为会话失效（`pages/P02` §8：401 统一跳登录路由）；
 * 其余错误码仍走 `ErrorNotice`，不白屏。
 */
export const hasUnauthenticated = (codes: readonly (string | undefined)[]): boolean =>
  codes.includes('UNAUTHENTICATED');

/**
 * 把 URL 里的值对着配置表核一遍（`pages/P02` §10 的「非法值回退」）：形状合法但配置里不存在的
 * 年代代号 / 场景 id 一律当作未选，不让它进 gate 与组合匹配；配置还没取到（`null`）时按未选处理。
 * 只读 `eras[].code` 与 `scenes[].id`，故参数收窄成这两个字段。
 */
export const matchSelection = (
  config: { eras: readonly { code: string }[]; scenes: readonly { id: number }[] } | null,
  selection: Selection,
): Selection => {
  if (config === null) return { ...selection, eraCode: null, sceneId: null };
  return {
    eraCode: config.eras.some((era) => era.code === selection.eraCode) ? selection.eraCode : null,
    sceneId: config.scenes.some((scene) => scene.id === selection.sceneId) ? selection.sceneId : null,
    count: selection.count,
  };
};

/** 未确认（或不可用）的锚点回确认页（`pages/P02` §2；`SEC-01` 的前端半段）。 */
export const shouldRedirectToConfirm = (anchor: Pick<Anchor, 'confirmedByUser'>): boolean =>
  anchor.confirmedByUser !== true;

export const confirmPath = (anchorId: number): string => `/confirm/${anchorId}`;

/**
 * 接住反推推荐（`pages/P02` §7）：URL **未**带 `era` / `scene` 时，把内存态推荐的初值写进 URL。
 * 返回要 `router.replace` 的 href；无需改动时 `null`。URL 已带参数即用户手选优先——
 * **不消费**内存态、不动 URL。`take` 由调用方注入（`takeReverseSuggestion`），本函数保持纯函数。
 */
export const applyReverseSuggestion = (
  pathname: string,
  params: SearchParamsLike,
  take: () => ReverseSuggestion | null,
): string | null => {
  const current = readSelection(params);
  if (current.eraCode !== null || current.sceneId !== null) return null;

  const suggestion = take();
  if (suggestion === null) return null;
  if (suggestion.eraCode === null && suggestion.sceneId === null) return null;

  return writeSelection(pathname, {
    eraCode: suggestion.eraCode,
    sceneId: suggestion.sceneId,
    count: current.count,
  });
};
