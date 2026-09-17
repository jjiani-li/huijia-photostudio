# M05 · 年代场景配置与 Prompt 拼装

> **层级**：实现规格层 · 后端模块
> **上游**：`docs/raw/AIGC_PRD.md` §5、§7 ／ `spec/01-领域模型与数据库.md`、`spec/05-Prompt工程.md`、`spec/era-scene-seed.json`
> **下游**：`modules/M06-生成编排.md`、`pages/P02-年代与场景选择.md`、`tickets/T08-年代场景配置与Prompt拼装.md`

> 只做两件事：把 `eras` / `scenes` / `era_scene_profiles` 三张只读配置表安全地喂给前端；把「身份锚点 + 年代包 + 场景包 + 模板常量 + 组合微调」拼成唯一一份可复现的 prompt。

## 1. 职责与边界

本模块做五件事：① 配置资产只读读取（4 个年代 / 5 个场景 / 20 组组合档案）→ `readEraSceneConfig()`；② 年代场景选项下发，**不含任何 prompt 正文** → `GET /api/config/era-scene`；③ prompt 拼装的唯一入口与固定段落常量 → `buildPrompt` / `template.ts`；④ 版本常量的定义与落库映射 → `versions.ts` → `generations` 的三个版本列；⑤ `eras.default_size` → `params_json.size` 的取值与合法性校验收口 → `generationService`；**不做**（违反即返工）：

- ❌ **不写配置表**：三张配置表的唯一写入路径是 `pnpm seed`（`spec/01-领域模型与数据库.md` §5.2），本模块的 repository 只有 `SELECT`。
- ❌ **不在业务代码里内联 prompt 文本**（`spec/05-Prompt工程.md` §1）；任何形如 `const p = "【年代】…"` 的写法都视为返工。
- ❌ **不调用 Ark、不碰数据库 / 文件系统 / 时钟**：`prompt/build.ts` 只接收已查好的对象（`spec/04-技术基线与目录结构.md` §3.1 第 3 条）。
- ❌ **不下发 prompt 正文**（理由见 §4.1 末段）；**不做任务状态机与生成后复核**——`generations.status` 流转、worker、重试、额度归 `modules/M06-生成编排.md`，年代穿帮与年龄偏差归 `modules/M07-生成后复核与内容审核.md`。

## 2. 涉及文件

| 文件 | 职责 |
|---|---|
| `app/api/config/era-scene/route.ts` | `requireUser()` → `readEraSceneConfig()` → 组装响应（`spec/04-技术基线与目录结构.md` §3.1 第 1 条允许该端点直接调 repository） |
| `src/server/db/repositories/config.ts` + `config.test.ts` | 三张配置表的只读查询与 `snake_case` → `camelCase` 映射，唯一 SQL 出处；实现 §3.1 的 7 个符号 |
| `src/server/prompt/build.ts` / `template.ts` / `versions.ts` + `build.test.ts` | 拼装唯一入口、7 个段落标签常量、版本常量（§5.1–§5.3） |
| `src/server/domain/generationService.ts` / `errors.ts` / `src/shared/types.ts` / `src/server/db/seed.ts` | 配置命中、size 校验、写 `generations` 的拼装类字段；复用既有 `AppError` 与错误码常量（**不新增错误码**）；§4.1 的 DTO 与 zod schema；配置文本唯一来源（读 `spec/era-scene-seed.json` 幂等 upsert，**不由本 ticket 交付**） |

## 3. 数据读写

### 3.1 读（全部为 `SELECT`）

| 表 | 读取字段 | 条件 |
|---|---|---|
| `eras` | `code` `name` `slug` `is_mono` `default_size` `style_json` `prompt_pack` `constraint_pack` `caption` `sample_photo` `pack_version` `sort_order` | `WHERE eras.is_active = 1` |
| `scenes` | `id` `code` `name` `slug` `category` `space_pack` `caption` `sample_photo` `pack_version` `sort_order` | `WHERE scenes.is_active = 1` |
| `era_scene_profiles` | `id` `era_code` `scene_id` `visual_signature` `prompt_override` `confidence` `sample_photo` | `WHERE era_scene_profiles.is_active = 1` |

排序（**不可发明列**）：`eras` 按 `ORDER BY sort_order ASC, code ASC`；`scenes` 按 `ORDER BY sort_order ASC, id ASC`；`era_scene_profiles` **没有 `sort_order` 列**，按 `ORDER BY era_code ASC, scene_id ASC`（`code` 为 `E1`–`E4` 文本，SQLite 字典序即年代顺序）。查询方案（**避免 N+1**）：`readEraSceneConfig()` 只发 **3 条 SQL**，随后在内存里按 `era_code` + `scene_id` 组装；**不得**对 20 行 profile 逐行再查 era / scene。

```ts
// src/server/db/repositories/config.ts
export interface EraRecord { code: string; name: string; slug: string; isMono: boolean; defaultSize: string; styleJson: unknown; promptPack: string; constraintPack: string; caption: string; samplePhoto: string | null; packVersion: string; isActive: boolean; sortOrder: number; }
export interface SceneRecord { id: number; code: string; name: string; slug: string; category: string | null; spacePack: string; caption: string; samplePhoto: string | null; packVersion: string; isActive: boolean; sortOrder: number; }
export interface EraSceneProfileRecord { id: number; eraCode: string; sceneId: number; visualSignature: string; promptOverride: string | null; confidence: number; samplePhoto: string | null; }
export interface EraSceneConfigRecord { eras: EraRecord[]; scenes: SceneRecord[]; profiles: EraSceneProfileRecord[]; }
export function readEraSceneConfig(): EraSceneConfigRecord;                            // 配置端点：一次 3 条 SELECT，内存组装
export function getEra(code: string): EraRecord | null;  export function getScene(id: number): SceneRecord | null;  export function getProfile(eraCode: string, sceneId: number): EraSceneProfileRecord | null;   // generationService：各 1 条 SELECT
```

三个单行取值函数同样只返回 `is_active = 1` 的行：`is_active = 0` 与「不存在」对调用方不可区分，都返回 `null`，由 `generationService` 统一映射为 `400 INVALID_PARAM`（`spec/03-接口契约.md` §3.5 把两种情况合为一条）。

**`samplePhoto` 的三条硬规则**：① 值是**前端静态资源路径原文**（如 `/samples/era-E2.png`），来自 `spec/era-scene-seed.json` 的 `samplePhoto`，**不是 `photos.id`**——不 `LEFT JOIN photos`、不拼 `/api/photos/:id/file` 形式的 URL；② **可为 `null`**，表示该年代 / 场景 / 组合没有真实样片；③ **本期 4 个年代 / 5 个场景 / 20 组组合的 `samplePhoto` 全部为 `null`**——仓库里唯一的真实留存照片只有 `docs/老照片/` 的两张输入图，`docs/output/` 下与产品相关的 3 张实测均为 2048×2048 的模型生成输出（恰为各年代的 `defaultSize`），不是真实留存图，故不得充当样片。**禁止**用占位图、mock 生成的假图或 AI 生成图凑数（`spec/09-施工纪律.md` D12）。前端一律降级为纯文字卡片。

**写（仅一处）**：`generations` 那一行的写入动作（单事务）与 `anchor_id` / `requested_count` / `reference_photo_ids` / `status` / `attempt` / `created_at` 归 `modules/M06-生成编排.md` §5.2；本模块只固定其中「拼装产物」列的取值：

| 列 | 取值来源 |
|---|---|
| `era_code` / `scene_id` / `profile_id` | 请求参数（已校验 `is_active = 1`）；`profile_id` 为按 `(era_code, scene_id)` 命中的 `era_scene_profiles.id`，未命中为 `NULL` |
| `prompt` / `prompt_hash` / `template_version` | `buildPrompt(...)` 的三个返回字段，原样写入，不做加工 |
| `era_pack_version` / `scene_pack_version` | `era.packVersion` / `scene.packVersion` |
| `model` / `params_json` | `process.env.ARK_IMAGE_MODEL` / `JSON.stringify({ size, outputFormat, watermark, provider })`（§5.2） |

## 4. 对外接口

### 4.1 `GET /api/config/era-scene`

端点定义、鉴权、响应形状与降级规则见 `spec/03-接口契约.md` §3.4，此处不复述。实现要点：

1. handler 开头 `requireUser()`，失败由 `withErrorHandling()` 转 `401 UNAUTHENTICATED`（`spec/03-接口契约.md` §1.2）；
2. 字段映射：`is_mono` → `isMono`、`sort_order` → `sortOrder`、`era_code` / `scene_id` → `eraCode` / `sceneId`（`spec/03-接口契约.md` §1.1：数据库的 `snake_case` 不得泄漏到 API）；
3. **`samplePhoto` 可空透传**：`EraOption.sampleUrl` ← `eras.samplePhoto`、`SceneOption.coverUrl` ← `scenes.samplePhoto`，**原样透传**，不拼接、不加缓存参数、不做降级替换；`null` 时前端进入「无样片」状态（`pages/P02-年代与场景选择.md`），服务端不提供占位图；
4. 白名单：响应中**不做** `style_json`、`pack_version`、`is_active`、`prompt_*` 的透传（`spec/03-接口契约.md` §4 之外的多余键一律不出）；向 `POST /api/generations` 提供前置校验与拼装能力，校验顺序表见 `spec/03-接口契约.md` §3.5，不重复定义、不新增校验步骤（本模块新增的唯一校验是 §5.2 的 size 下限，属内部不变量）。

**`samplePhoto` 的 DTO 契约（供 `pages/P02-年代与场景选择.md` 对齐）**：

| 层 | 字段名 | 类型 | 来源 | `null` 语义 |
|---|---|---|---|---|
| 配置记录 | `samplePhoto` | `string \| null` | 种子 `samplePhoto` → 配置表 | 无真实样片 |
| `EraOption` | `sampleUrl` | `string \| null` | `eras.samplePhoto` 原样 | 年代卡降级为纯文字 |
| `SceneOption` | `coverUrl` | `string \| null` | `scenes.samplePhoto` 原样 | 场景卡降级为纯文字 |
| `EraSceneProfileRecord` | `samplePhoto` | `string \| null` | `era_scene_profiles.samplePhoto` | 组合无样片 |
| `EraSceneProfile` | `sampleUrl` | `string \| null` | `era_scene_profiles.samplePhoto` 原样 | 组合预览降级为纯文字（`pages/P02-年代与场景选择.md` §4） |

`EraSceneProfile` DTO 已含样片字段 `sampleUrl`（`spec/03-接口契约.md` §4），与 `EraOption.sampleUrl` 同名、语义一致：组合档案的 `era_scene_profiles.samplePhoto` 原样透传，`null` 时组合预览只显示 `visualSignature`（`pages/P02-年代与场景选择.md` §4）。

**为什么绝不下发 prompt 正文**：`eras.prompt_pack`、`scenes.space_pack`、`eras.constraint_pack`、`era_scene_profiles.prompt_override` 是产品核心竞争资产（`spec/05-Prompt工程.md` §1）与可反推的调参知识；前端拿不到就不存在「篡改后再提交」的攻击面（`spec/03-接口契约.md` §6 已禁止前端拼 prompt），而 `generations.prompt` 已全文落库，将来做只读展示也不必经过前端拼装。契约验证点是 `API-06`：响应中命中任一字段即为失败。

## 5. 关键流程

**配置端点无状态**：`requireUser()` → 3 条 `SELECT`（§3.1）→ 内存组装 `{ version, confidenceHintThreshold, realismAnchor, eras[], scenes[], profiles[] }` → `ok(config)`。三张配置表**纯数据且只读**，本模块没有状态机；配置变更的唯一入口是「改 `spec/era-scene-seed.json` → 递增对应 `packVersion` → `pnpm seed`」（`spec/05-Prompt工程.md` §7.3），`pnpm seed` 必须满足 `eras=4`、`scenes=5`、`era_scene_profiles=20`，否则非零退出（`spec/01-领域模型与数据库.md` §5.2）。

### 5.1 `buildPrompt`（纯函数）

签名与返回类型以 `spec/05-Prompt工程.md` §2.2 为准：

```ts
// src/server/prompt/build.ts
export interface BuildPromptInput { anchorText: string; era: EraRecord; scene: SceneRecord; profile: EraSceneProfileRecord | null; }
export interface BuildPromptResult { prompt: string; promptHash: string; templateVersion: string; }
export function buildPrompt(input: BuildPromptInput): BuildPromptResult;
```

实现要点（全部是硬规则）：

1. **段落顺序固定**，不得排序、不得条件重排：`sections` 是字面量数组，顺序为 `SECTION_IDENTITY + IDENTITY_LEAD + anchorText` → `SECTION_AGE + AGE_PRESERVE_CLAUSE` → `SECTION_ERA + era.promptPack` → `SECTION_SCENE + scene.spacePack` → `SECTION_REALISM + REALISM_ANCHOR` → `SECTION_ERA_FIT + era.constraintPack`；前六段由 `build.ts` 无条件输出（变量为空串时只让该段变短，不漏段）；
2. **段间分隔符是单个换行 `"\n"`**：`sections.join("\n")`；不插空行、不插分隔线、不做 `trim()` 合并；
3. **段内原文换行与空格原样保留**：`anchorText` / `promptPack` / `spacePack` / `constraintPack` / `promptOverride` 一律不 trim、不折叠、不替换全角半角；
4. **`prompt_override` 为 `null`（或全空白）时整段省略**：数组中不 push `【组合微调】`，`prompt` 尾部不留多余换行；
5. `promptHash = createHash("sha256").update(prompt, "utf8").digest("hex")`（Node 默认小写十六进制，长度 64）；函数体内**不得**出现 `Date`、`Math.random`、环境变量读取、数据库访问、文件读取——`PR-08` 要求同一组合连续两次拼装完全一致；也不得在本函数之外的任何地方拼 prompt。

```ts
const override = input.profile?.promptOverride ?? null;
if (override !== null && override.trim() !== "") sections.push(SECTION_PROFILE + override);
const prompt = sections.join("\n");
```

**段落常量与正文来源**（`src/server/prompt/template.ts`）：七个段落标签常量 `SECTION_IDENTITY`【身份锚点】、`SECTION_AGE`【年龄保真】、`SECTION_ERA`【年代】、`SECTION_SCENE`【场景】、`SECTION_REALISM`【质感】、`SECTION_ERA_FIT`【年代一致】、`SECTION_PROFILE`【组合微调】（条件段落，`PR-09`）。**段落正文不在本文件复制**：模板全文以 `spec/05-Prompt工程.md` §2 为权威副本，`template.ts` 的 `IDENTITY_LEAD`、`AGE_PRESERVE_CLAUSE`、`REALISM_ANCHOR` 逐字符照抄 `spec/05-Prompt工程.md` §2 与 `spec/era-scene-seed.json` 的 `agePreserveClause` / `realismAnchor`，不得改写、不得增删标点；两者不一致时以种子文件为准并同步代码。§2 示意代码里段落之间的空行是 Markdown 折行，**实际分隔符是单个 `\n`**（本条规则 2）。【年龄保真】段是防美化三处落点之一（`spec/05-Prompt工程.md` §4），**不可删除、无开关**。

**长度断言只 warn 不阻断**：区间 `[200, 1200]` 字符（`PR-07`；`spec/05-Prompt工程.md` §9 的目标区间 300–900 是其建议子集）。超限行为：`logger.warn({ job: 'generate', era: era.code, sceneId: scene.id, length }, 'prompt length out of range')`，**不 throw、不改写文本、不截断**——长度是质量信号而非正确性条件，截断会破坏 `PR-08` 的确定性并把种子数据的问题掩盖成静默降级。

### 5.2 `size` 从 `eras.default_size` 到 `params_json`

1. `eras.default_size`（形如 `"2048x2048"`）按 `/^(\d+)x(\d+)$/` 解析为 `width` / `height`；解析失败即内部 bug；
2. 校验总像素 **≥ 3,686,400**（`README.md` §4.1：低于即上游 `InvalidParameter`），总像素 ≤ 16,777,216，宽高比 ∈ [1/16, 16]（同表）；
3. 通过后原样以字符串写入 `params_json.size = era.defaultSize`，不重新格式化；`params_json.outputFormat` 固定 `"png"`、`watermark` 取 `WATERMARK_DEFAULT` 的布尔值、`provider` 取 `PROVIDER`；
4. 校验在**创建任务时、写入 `generations` 之前**执行（fail fast），是 `modules/M06-生成编排.md` §5.2 事务内那次赋值的守卫，**不改变 `spec/03-接口契约.md` §3.5 的校验顺序、不新增校验步骤**；失败结果与上游返回 `InvalidParameter` 一致，都是 `INTERNAL`（`spec/03-接口契约.md` §5.1）。种子数据合法时该分支永不触发，`ERR-03` 覆盖的是上游路径。

### 5.3 版本常量与落库映射

| 常量 / 列 | 值 | 落库位置 | 谁写入 |
|---|---|---|---|
| `PROMPT_TEMPLATE_VERSION` | `tpl-v1` | `generations.template_version` | `generationService` 取 `buildPrompt(...).templateVersion` 原样写入 |
| `eras.pack_version` | `v1` | `generations.era_pack_version` | `generationService` 取 `era.packVersion` |
| `scenes.pack_version` | `v1` | `generations.scene_pack_version` | `generationService` 取 `scene.packVersion` |
| `ANCHOR_PROMPT_VERSION` | `anchor-v1` | `identity_anchors.prompt_version`，**不入 `generations`** | 由锚点提取任务写入（`tickets/T06-身份锚点提取.md`） |
| `SEED_VERSION` | `seed-v1` | 不下库，作为响应顶层 `version` | 必须与 `spec/era-scene-seed.json` 顶层 `version` 相等（`DB-06`） |

`generations` 只有三个版本列（`spec/01-领域模型与数据库.md` §3.9），**不为锚点 prompt 版本新增列**：该版本经 `generations.anchor_id` → `identity_anchors.prompt_version` 间接可查，而 `anchor_text` 已全文嵌在 `generations.prompt` 里，锚点行被重新提取也不影响历史 prompt。递增规则（`spec/05-Prompt工程.md` §7.2）：改 `template.ts` 的段落结构或常量文本 → 递增 `PROMPT_TEMPLATE_VERSION`；改 `eras.prompt_pack` / `eras.constraint_pack` → 递增 `eras.pack_version`；改 `scenes.space_pack` → 递增 `scenes.pack_version`；`prompt_override` 无独立版本列，随 `era_scene_profiles` 行一起变更。

## 6. 边界与错误

错误码必须与 `spec/03-接口契约.md` §5 的「错误码 → 触发条件 → 用户可见文案」逐字符一致。

| 错误码 | HTTP | 触发条件 | 用户可见文案 |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | 未登录或会话过期访问 `GET /api/config/era-scene` | 请先登录 |
| `INVALID_PARAM` | 400 | `eraCode` / `sceneId` 在 `eras` / `scenes` 中不存在，或该行 `is_active = 0`（`spec/03-接口契约.md` §3.5） | 选择有误，请重新选一下 |
| `ANCHOR_NOT_CONFIRMED` | 409 | 锚点虽为 `succeeded` 但 `anchor_text` 为空——`spec/01-领域模型与数据库.md` §2.1 的锚点可用性不变量被破坏 | 需要先确认"这就是他"，才能开始生成 |
| `INTERNAL` | 500 | `eras.default_size` 解析失败，或总像素低于 3,686,400 / 高于 16,777,216 / 宽高比越界（内部拼装 bug，`spec/03-接口契约.md` §5.1） | 出了点小问题，请重试 |

边界行为（不报错）：

| 情况 | 行为 |
|---|---|
| `(era_code, scene_id)` 未命中 `era_scene_profiles` | `profile = null`，走「年代包 + 场景包」两层拼装（`spec/05-Prompt工程.md` §2.1） |
| `profile.confidence < 0.6` | 服务端照常返回；是否提示由前端按响应里的 `confidenceHintThreshold` 决定（`DB-04`） |
| `eras` / `scenes` 为空（未跑 `pnpm seed`） | 端点返回 `200` + 空数组；问题由 `GET /api/health` 的 `db.eras` 计数暴露（`spec/03-接口契约.md` §3.7） |
| `samplePhoto` 为 `null` | 对应 URL 字段下发 `null`，前端展示「暂无示例」的纯文字卡片（`pages/P02-年代与场景选择.md`） |

## 7. 配置与环境变量

只使用 `spec/08-本地开发指南.md` §4 已声明的变量，**不新增**：

| 变量 | 默认 | 本模块的用法 |
|---|---|---|
| `DATABASE_PATH` | `./data/app.db` | 经 `getDb()` 间接使用；`config.ts` 不直接读该变量 |
| `PROVIDER` | `mock` | 写入 `params_json.provider`，值域 `mock` / `real` |
| `ARK_IMAGE_MODEL` | `doubao-seedream-5-0-lite-260128` | 写入 `generations.model` |
| `WATERMARK_DEFAULT` | `false` | 写入 `params_json.watermark` |

不在本模块读取：`ARK_API_KEY`（只有 `RealArkProvider` 读）、`ARK_VISION_MODEL`、`ARK_BASE_URL`、`ARK_TIMEOUT_SECONDS`、`STORAGE_DIR`、`MAX_UPLOAD_MB`、`WORKER_STALE_MINUTES`、`WORKER_CONCURRENCY`、`JOB_TIMEOUT_SECONDS`、`SMS_PROVIDER`、`DEV_LOGIN_CODE`、`ID_VERIFY_PROVIDER`、`GENERATION_DEFAULT_COUNT`、`AIGC_IMPLICIT_MARKER`。

## 8. 测试要点

单元测试（`pnpm test`，vitest）：

- `build.test.ts`：20 组 `(eraCode, sceneId)` 均含 6 个固定段落标签且 `indexOf` 严格递增；对 `/不要|禁止|no\s|without/` 零命中；均含 `不做任何美化` 与 `减龄`；E1 的 5 组含 `黑白`、E3 / E4 的 10 组不含 `胶片`；长度 ∈ [200, 1200] 且越界时 mock 的 `logger.warn` 被调用而不抛错；同输入两次 `prompt` 与 `promptHash` 全等（64 位小写十六进制）、段间为单个 `\n`、含换行的 `anchorText` 原样保留；`promptOverride === null` 时不含 `【组合微调】`、非 `null` 时必须含且在末尾。
- `config.test.ts`：返回 4 / 5 / 20 行、`is_active = 0` 的行不出现、`eras.sort_order` 为 1,2,3,4；`db.prepare` 总执行次数为 3（无 N+1）；`samplePhoto` 要么是 `/samples/` 开头的路径字符串、要么是 `null`，不做任何拼接（**本期全为 `null`**，断言 4 / 5 / 20 行全部为 `null`）。
- `generationService.test.ts`：`2048x2048` 通过，`1024x1024` / `1000x3686` 抛 `INTERNAL`；`template_version='tpl-v1'` 且两个 pack 版本取行值；`anchorText` 为空 → `ANCHOR_NOT_CONFIRMED`。

**本模块负责的检查项**（权威定义见 `spec/07-验收标准.md` §2.2）：`PR-01` / `PR-02` 靠 `sections` 字面量数组与 6 个 `SECTION_*` 常量；`PR-03` 靠两段模板常量与种子的全正面化文本；`PR-05` / `PR-06` 靠 E1 种子的「黑白影调 / 全画面无彩色」与不含「胶片」的锚定词、年龄保真句、E3 / E4 包（`spec/05-Prompt工程.md` §3、§5）；`PR-07` 由种子数据与模板常量的实际长度满足；`PR-08` 靠纯函数 + 无盐无时间戳的 `promptHash`；`PR-09` 靠 §5.1 规则 4 的 `null` / 空白分支。`PR-04`（防美化句断言）归属 `modules/M03-身份锚点提取.md`，本模块只提供【年龄保真】段这一处防美化落点。关联的 B 层检查项：`API-02`（zod 形状）、`API-06`（不下发 prompt 字段）、`DB-05`（`default_size` 总像素 ≥ 3,686,400）、`ERR-03`（上游 `InvalidParameter` → `INTERNAL`）、`E2E-03`（落库 `generations.prompt` 与 `buildPrompt` 输出逐字符相等）。

## 9. 非目标与待定决策

**非目标（留扩展位）**：配置管理后台——本期配置变更只走 `pnpm seed`，`spec/era-scene-seed.json` 是权威副本，后台只是它的另一个写入口；自定义场景描述——会引入 prompt 注入与审核成本（`spec/00-总纲.md` §6.2），扩展位是 `scenes` 可插入行 + `prompt_override`；prompt 侧的其余非目标（用户可编辑 prompt、LLM 自动改写年代包、负向提示词通道、组合级 A/B 分流）见 `spec/05-Prompt工程.md` §10。

**待定决策（落地前必须收口）**：

1. ~~**`samplePhoto` 的落库形态在表结构侧尚未定稿**~~ **已收口**：统一为 **TEXT 前端静态资源路径**（如 `/samples/era-E2.png`），来自 `spec/era-scene-seed.json` 的 `samplePhoto`；`spec/01-领域模型与数据库.md` §3.6 / §3.7 / §3.8 与 `spec/02-schema.sql` 的三列均定名为 `sample_photo`，不再有 `sample_photo_id` / `cover_photo_id` 与 `photos(id)` 外键。
2. ~~**组合档案的样片当前下不去，但 `pages/P02-年代与场景选择.md` §4 已要求展示**~~ **已收口**：`spec/03-接口契约.md` §3.4 / §4 已为 `EraSceneProfile` 补 `sampleUrl: string | null`（与 `EraOption` 同名），本模块按 §3.1 原样透传；`pages/P02-年代与场景选择.md` §4 的 `ComboPreview` 按有 / 无样片两态渲染。
3. **`params_json.outputFormat` 无环境变量来源**：`spec/08-本地开发指南.md` §4 未定义输出格式开关，本期固定 `"png"`；要支持 `jpeg` 必须先补环境变量文档再改代码。

## 10. 与上游文档的差异

| 上游（`docs/raw/AIGC_PRD.md` 或 `.scratch/` 实测脚本） | 本方案 | 依据 |
|---|---|---|
| §5.1「最终 prompt = 身份锚点 + 年代质感包 + 场景空间包 + 写实锚定词 ± 组合微调」共 4 段 | 7 段：`【身份锚点】【年龄保真】【年代】【场景】【质感】【年代一致】【组合微调】`，模板版本 `tpl-v1` | 模型无 `negative_prompt`，年龄保真与年代一致必须各占一个独立正向段落（`spec/05-Prompt工程.md` §2、§4） |
| §5.2 / §5.3 把「典型服装道具」写进年代轴与场景轴（如 S4 的搪瓷杯、S5 的自行车） | 场景包保持**跨年代中性**，年代特定物件一律下沉到 `era_scene_profiles.prompt_override` | 同一场景包必须在 E1 与 E4 下都成立，否则年代包会被场景包污染（`spec/05-Prompt工程.md` §6） |
| §7.1 写实锚定词含「[年代专属颗粒与画质描述]」等占位与 `[年代]` 插值 | 定稿为 `spec/era-scene-seed.json` 的 `realismAnchor` 固定文本，不含「胶片」字样 | 占位符无法逐字符复现（`PR-08`）；插值会把年代信息重复注入【质感】段（`spec/05-Prompt工程.md` §5） |
| `.scratch/seedream_era_scene.js` 的【年代一致】段写作「…**不出现**该年代之后才有的物件」 | 改用 `eras.constraint_pack` 的**全正面化**文本，脚本写法作废 | 负向表达在该模型上无效，`PR-03` 要求全 prompt 对否定词零命中（`spec/05-Prompt工程.md` §3） |
| §8.2 要求年代卡片「每张配该年代样片」 | 只有真实留存样片才展示，其余如实标注「暂无示例」，无样片即纯文字卡 | 样片只能用真实图（`spec/era-scene-seed.json` 的 `samplePhoto`、`spec/00-总纲.md` §6.2） |
