# M05 · 年代场景配置与 Prompt 拼装

> **层级**：实现规格层 · 后端模块
> **上游**：`docs/raw/AIGC_PRD.md` §5、§7 ／ `spec/01-领域模型与数据库.md`、`spec/05-Prompt工程.md`
> **下游**：`modules/M06-生成编排.md`、`tickets/T08`

> 只做两件事：把 `eras` / `scenes` / `era_scene_profiles` 三张只读配置表安全地喂给前端，以及把「身份锚点 + 年代包 + 场景包 + 模板常量 + 组合微调」拼成唯一一份可复现的 prompt。

---

## 1. 职责与边界

### 1.1 做什么

| # | 职责 | 产物 |
|---|---|---|
| 1 | 配置资产只读读取：4 个年代、5 个场景、20 组组合档案 | `readEraSceneConfig()` |
| 2 | 年代场景选项下发（**不含任何 prompt 正文**） | `GET /api/config/era-scene` |
| 3 | prompt 拼装的唯一入口与固定段落常量 | `buildPrompt` / `template.ts` |
| 4 | 版本常量的定义与落库映射 | `versions.ts` → `generations` 三个版本列 |
| 5 | `eras.default_size` → `params_json.size` 的取值与合法性校验收口 | `generationService` |

### 1.2 明确不做什么

- ❌ **不写配置表**。`eras` / `scenes` / `era_scene_profiles` 的唯一写入路径是 `pnpm seed`（`spec/01-领域模型与数据库.md` §5.2），本模块的 repository 只有 `SELECT`。
- ❌ **不调用 Ark、不访问文件系统**。`prompt/build.ts` 不碰数据库、不碰网络、不碰时间（`spec/04-技术基线与目录结构.md` §3.1 第 3 条）。
- ❌ **不在业务代码里内联 prompt 文本**（`spec/05-Prompt工程.md` §1）。任何形如 `const p = "【年代】…"` 的写法都视为返工。
- ❌ **不下发 prompt 正文**。前端永远拿不到 `prompt_pack` / `space_pack` / `constraint_pack` / `prompt_override`（理由见 §4.2）。
- ❌ **不做任务状态机**。`generations.status` 的流转、worker、重试、额度归 `modules/M06-生成编排.md`；本模块只在创建时提供「拼装产物」这几列。
- ❌ **不做生成后复核**。年代穿帮与年龄偏差归 `modules/M07-生成后复核与内容审核.md`。

---

## 2. 涉及文件

| 文件 | 职责（一句话） |
|---|---|
| `app/api/config/era-scene/route.ts` | `GET /api/config/era-scene`：`requireUser()` → 调 `readEraSceneConfig()` → 组装响应；`spec/04-技术基线与目录结构.md` §3.1 允许该端点直接调 repository |
| `src/server/db/repositories/config.ts` | 三张配置表的只读查询与行 → 领域对象映射（`snake_case` → `camelCase`），唯一 SQL 出处；对外提供 `readEraSceneConfig()` 与三个单行取值函数 |
| `src/server/prompt/template.ts` | `tpl-v1` 的 7 个段落标签（6 个固定段落 + 1 个条件段落）与 2 段固定正文常量（写实锚定词、年龄保真句） |
| `src/server/prompt/build.ts` | `buildPrompt` 唯一入口：段落拼接、长度 warn、`prompt_hash` |
| `src/server/prompt/versions.ts` | `tpl-v1` / `anchor-v1` 版本常量，以及配置端点用的 `seed-v1` / `0.6`（见 §9 待定决策 1） |
| `src/server/domain/generationService.ts` | 生成编排前半段：配置命中、size 校验、调 `buildPrompt`、写 `generations` 的拼装类字段 |
| `src/server/domain/errors.ts` | 复用既有 `AppError` 与错误码常量，本模块不新增错误码 |
| `src/shared/types.ts` | 增补 `EraOption` / `SceneOption` / `EraSceneProfile` / `EraSceneConfig` 与对应 zod schema（形状以 `spec/03-接口契约.md` §4 为准） |
| `src/server/db/seed.ts` | **不由本 ticket 交付**，但配置文本的唯一来源；读取 `docs/prd/spec/era-scene-seed.json` 幂等 upsert |
| `src/server/prompt/build.test.ts` | 段落、顺序、否定词、长度、确定性、`prompt_override` 分支的单元测试（路径约定见 §9 待定决策 5） |
| `src/server/db/repositories/config.test.ts` | 过滤与排序、样片 URL 降级、无 N+1 的单元测试 |

---

## 3. 数据读写

### 3.1 读（全部为 `SELECT`）

| 表 | 读取字段 | 条件 |
|---|---|---|
| `eras` | `code` `name` `slug` `is_mono` `default_size` `style_json` `prompt_pack` `constraint_pack` `caption` `sample_photo_id` `pack_version` `sort_order` | `WHERE eras.is_active = 1` |
| `scenes` | `id` `code` `name` `slug` `category` `space_pack` `caption` `cover_photo_id` `pack_version` `sort_order` | `WHERE scenes.is_active = 1` |
| `era_scene_profiles` | `id` `era_code` `scene_id` `visual_signature` `prompt_override` `confidence` | `WHERE era_scene_profiles.is_active = 1` |
| `photos` | `id` `deleted_at` | 仅 LEFT JOIN 校验样片是否可用，不取其他列 |

排序规则（**不可发明列**）：

- `eras`：`ORDER BY sort_order ASC, code ASC`；
- `scenes`：`ORDER BY sort_order ASC, id ASC`；
- `era_scene_profiles`：**该表没有 `sort_order` 列**，`ORDER BY era_code ASC, scene_id ASC`（`code` 为 `E1`–`E4` 文本，SQLite 字典序即年代顺序）。

查询方案（**避免 N+1**）：`readEraSceneConfig()` 只发 **3 条 SQL**（eras / scenes / profiles），随后在内存里按 `era_code` + `scene_id` 组装；**不得**对 20 行 profile 逐行再查 era/scene。

```ts
// src/server/db/repositories/config.ts
export interface EraRecord {
  code: string; name: string; slug: string; isMono: boolean; defaultSize: string;
  styleJson: unknown; promptPack: string; constraintPack: string; caption: string;
  samplePhotoId: number | null; packVersion: string; isActive: boolean; sortOrder: number;
}
export interface SceneRecord {
  id: number; code: string; name: string; slug: string; category: string | null;
  spacePack: string; caption: string; coverPhotoId: number | null;
  packVersion: string; isActive: boolean; sortOrder: number;
}
export interface EraSceneProfileRecord {
  id: number; eraCode: string; sceneId: number; visualSignature: string;
  promptOverride: string | null; confidence: number;
}
export interface EraSceneConfigRecord {
  eras: EraRecord[]; scenes: SceneRecord[]; profiles: EraSceneProfileRecord[];
}

// 配置端点用：一次 3 条 SELECT，内存组装
export function readEraSceneConfig(): EraSceneConfigRecord;

// generationService 用：单行取值，各 1 条 SELECT（见 §5.4）
export function getEra(code: string): EraRecord | null;
export function getScene(id: number): SceneRecord | null;
export function getProfile(eraCode: string, sceneId: number): EraSceneProfileRecord | null;
```

三个单行取值函数同样只返回 `is_active = 1` 的行：`is_active = 0` 与「不存在」对调用方不可区分，都返回 `null`，由 `generationService` 统一映射为 `400 INVALID_PARAM`（`spec/03-接口契约.md` §3.5「`eraCode` / `sceneId` 不存在或 `is_active=0`」把两种情况合为一条）。

`samplePhotoId` / `coverPhotoId` 的取得方式：`LEFT JOIN photos p ON p.id = eras.sample_photo_id AND p.deleted_at IS NULL`，取不到则为 `null`，防止把已软删除的样片 URL 下发出去。

### 3.2 写（仅一处）

`generations` 那一行的**写入动作**由 `modules/M06-生成编排.md` §5.2 的 `createGeneration` 在单个事务里完成；本文件只固定其中「拼装产物」列的取值规则（`modules/M06-生成编排.md` 的代码草稿里写的是 `params: { size: era.defaultSize, ... }`，本文件在 §5.4 为这个赋值加上一道解析与像素校验）：

| 列 | 取值来源 |
|---|---|
| `era_code` | 请求参数，已校验在 `eras` 中且 `is_active = 1` |
| `scene_id` | 请求参数，已校验在 `scenes` 中且 `is_active = 1` |
| `profile_id` | 按 `(era_code, scene_id)` 命中的 `era_scene_profiles.id`；未命中为 `NULL` |
| `prompt` | `buildPrompt(...).prompt`（全文） |
| `prompt_hash` | `buildPrompt(...).promptHash` |
| `template_version` | `buildPrompt(...).templateVersion` |
| `era_pack_version` | `era.packVersion`（即 `eras.pack_version`） |
| `scene_pack_version` | `scene.packVersion`（即 `scenes.pack_version`） |
| `model` | `process.env.ARK_IMAGE_MODEL` |
| `params_json` | `JSON.stringify({ size, outputFormat, watermark, provider })` |

`anchor_id`、`requested_count`、`reference_photo_ids`、`status`、`attempt`、`created_at` 由 `modules/M06-生成编排.md` 负责，本模块不定义它们的取值规则。

---

## 4. 对外接口

### 4.1 `GET /api/config/era-scene`

端点定义、鉴权要求、响应形状与降级规则见 `spec/03-接口契约.md` §3.4，此处不复述。本模块的实现要点只有三条：

1. handler 开头 `requireUser()`，失败由 `withErrorHandling()` 转 `401 UNAUTHENTICATED`（`spec/03-接口契约.md` §1.2）；
2. 字段映射：`eras.is_mono`→`isMono`、`eras.sort_order`→`sortOrder`、`scenes.cover_photo_id`→`coverUrl`、`era_scene_profiles.era_code/scene_id`→`eraCode/sceneId`（`spec/03-接口契约.md` §1.1：数据库的 `snake_case` 不得泄漏到 API）；
3. `sampleUrl` = `samplePhotoId === null ? null : \`/api/photos/${samplePhotoId}/file?w=600\``，`coverUrl` 同理；两者为 `null` 时前端降级为纯文字卡片。

响应中**不做** `style_json`、`pack_version`、`is_active`、`prompt_*` 的透传——`spec/03-接口契约.md` §4 的 `EraOption` / `SceneOption` / `EraSceneProfile` 就是白名单，多余的键一律不出。

### 4.2 为什么绝不下发 prompt 正文

| 字段 | 不下发的理由 |
|---|---|
| `eras.prompt_pack` | 产品的核心竞争资产（`spec/05-Prompt工程.md` §1），下发即等于把整套 prompt 工程开源 |
| `scenes.space_pack` | 同上；且空间包外泄后，用户会开始「自己拼 prompt」 |
| `eras.constraint_pack` | 正面化改写表（`spec/05-Prompt工程.md` §3）是防年代穿帮的全部实现手段，属于可反推的调参知识 |
| `era_scene_profiles.prompt_override` | 20 组差异化微调，是「同样 9 段文本如何覆盖 20 格」的关键增量 |

安全上的直接理由：前端拿不到这些字段，就没有「篡改后再提交」的攻击面——拿不到的东西无法回传（`spec/03-接口契约.md` §6 第 1 条本已禁止前端拼 prompt）；且 `generations.prompt` 已全文落库（§3.2），将来做只读展示也不需要经过前端拼装。

契约层面的验证点是 `API-06`：响应中命中 `promptPack` / `spacePack` / `constraintPack` / `promptOverride` 任一即为失败。

### 4.3 与 `POST /api/generations` 的关系

本模块向该端点提供**前置校验与拼装**能力，校验顺序表见 `spec/03-接口契约.md` §3.5，不重复定义。本模块新增的唯一校验是 §5.4 的 `size` 像素下限（表内未列，属于内部不变量，见 §6）。

---

## 5. 关键流程与状态机

### 5.1 配置端点（无状态）

```
requireUser() → readEraSceneConfig()  ──┬─ SELECT eras  (is_active=1, sort_order)
                                        ├─ SELECT scenes(is_active=1, sort_order)
                                        └─ SELECT era_scene_profiles(is_active=1)
     → 内存组装 { version, confidenceHintThreshold, realismAnchor,
                  eras[], scenes[], profiles[] }
     → ok(config)
```

三个配置表是**纯数据且只读**，本模块没有状态机。配置变更的唯一入口是：改 `docs/prd/spec/era-scene-seed.json` → 递增对应 `packVersion` → `pnpm seed`（`spec/05-Prompt工程.md` §7.3）。`pnpm seed` 完成后必须满足 `eras=4`、`scenes=5`、`era_scene_profiles=20`，否则非零退出（`spec/01-领域模型与数据库.md` §5.2）。

### 5.2 `buildPrompt`（纯函数）

签名与返回值以 `spec/05-Prompt工程.md` §2.2 为准：

```ts
// src/server/prompt/build.ts
export interface BuildPromptInput {
  anchorText: string;
  era: EraRecord;
  scene: SceneRecord;
  profile: EraSceneProfileRecord | null;
}
export interface BuildPromptResult {
  prompt: string;
  promptHash: string;
  templateVersion: string;
}
export function buildPrompt(input: BuildPromptInput): BuildPromptResult;
```

实现要点（顺序即下文条号，全部是硬规则）：

1. **段落顺序固定**，不得排序、不得条件重排。拼接数组按下列字面量顺序构造 `sections: string[]`；
2. **段间分隔符是单个换行 `"\n"`**：`sections.join("\n")`。不插空行、不插分隔线、不做 `trim()` 合并；
3. **段内原文换行与空格原样保留**：`anchorText` / `promptPack` / `spacePack` / `constraintPack` / `promptOverride` 一律不 trim、不折叠、不替换全角半角；
4. **`prompt_override` 为 `null`（或全空白）时整段省略**，即数组中不 push `【组合微调】`，`prompt` 尾部不留任何多余换行；
5. `promptHash = createHash("sha256").update(prompt, "utf8").digest("hex")`：Node 默认小写十六进制，长度 64；
6. **长度断言只 warn 不阻断**（见 §5.5）；
7. 函数体内**不得**出现 `Date`、`Math.random`、环境变量读取、数据库访问、文件读取——`PR-08` 要求同一组合连续两次拼装完全一致；
8. 不在本文件之外的任何地方拼 prompt；`generationService` 只调用本函数。

段落组成（前缀即 `template.ts` 的段落标签常量）：

```ts
const sections: string[] = [
  SECTION_IDENTITY + IDENTITY_LEAD + input.anchorText,
  SECTION_AGE      + AGE_PRESERVE_CLAUSE,
  SECTION_ERA      + input.era.promptPack,
  SECTION_SCENE    + input.scene.spacePack,
  SECTION_REALISM  + REALISM_ANCHOR,
  SECTION_ERA_FIT  + input.era.constraintPack,
];
const override = input.profile?.promptOverride ?? null;
if (override !== null && override.trim() !== "") {
  sections.push(SECTION_PROFILE + override);
}
const prompt = sections.join("\n");
```

### 5.3 模板常量（`src/server/prompt/template.ts` 全文）

下引代码即该文件的完整内容，落地时逐字符照抄。`REALISM_ANCHOR` 与 `AGE_PRESERVE_CLAUSE` 必须分别与 `spec/era-scene-seed.json` 的 `realismAnchor` / `agePreserveClause` **逐字符一致**（同一段文本只能有一处定义，种子文件是权威副本，本文件是它的唯一代码镜像；两者不一致时以 `spec/era-scene-seed.json` 为准并同步本文件）。

```ts
// src/server/prompt/template.ts
// tpl-v1 段落常量。
// REALISM_ANCHOR / AGE_PRESERVE_CLAUSE 逐字符取自 docs/prd/spec/era-scene-seed.json
// 的 realismAnchor / agePreserveClause，不得改写、不得增删标点。
// 禁止在本文件之外内联 prompt 文本（spec/05-Prompt工程.md §1）。

export const SECTION_IDENTITY = "【身份锚点】";
export const SECTION_AGE      = "【年龄保真】";
export const SECTION_ERA      = "【年代】";
export const SECTION_SCENE    = "【场景】";
export const SECTION_REALISM  = "【质感】";
export const SECTION_ERA_FIT  = "【年代一致】";
export const SECTION_PROFILE  = "【组合微调】";

export const IDENTITY_LEAD =
  "严格保持参考图中人物的面部特征与身份一致，不同场景之间必须是同一个人：";

export const AGE_PRESERVE_CLAUSE =
  "严格保留人物的真实年龄特征：保持源照片中已有的深皱纹、法令纹、眼角纹、老年斑与皮肤松弛，不做任何美化、磨皮与减龄处理；面部结构、脸型与体型比例不做任何修饰。";

export const REALISM_ANCHOR =
  "真实照片，随手拍的生活照，自然皮肤纹理，可见毛孔与细纹，真实肤色不均，柔和的对比度，构图自然不刻意";
```

七个段落标签中，前六个合称固定段落，由 `build.ts` 无条件输出；`SECTION_PROFILE` 为条件段落（`PR-09`）。`spec/05-Prompt工程.md` §2 的示意代码里段落之间显示为空行，那是 Markdown 排版折行；**实际分隔符是单个 `\n`**（§5.2 第 2 条），且 `AGE_PRESERVE_CLAUSE` 在种子文件里是单行文本，段内无换行。

### 5.4 `size` 从 `eras.default_size` 到 `params_json`

1. 命中 `eras.default_size`（形如 `"2048x2048"`），按 `/^(\d+)x(\d+)$/` 解析为 `width` / `height`；解析失败即内部 bug；
2. 校验 **总像素 ≥ 3,686,400**（`README.md` §4.1：低于即上游 `InvalidParameter`），同时校验总像素 ≤ 16,777,216 且宽高比 ∈ [1/16, 16]（同表）；
3. 通过后原样以字符串写入：`params_json.size = era.defaultSize`（即 `"2048x2048"`），不做重新格式化；
4. `params_json.outputFormat` 固定 `"png"`、`params_json.watermark` 取 `WATERMARK_DEFAULT` 的布尔值、`params_json.provider` 取 `PROVIDER`（`spec/03-接口契约.md` §4 的 `Generation.params` 形状）；
5. 该校验在**创建任务时、写入 `generations` 之前**执行（fail fast，省一次上游调用）：接在 `modules/M06-生成编排.md` §5.2 第 6 步的事务内取值处，属于该次赋值的守卫，**不改变 §5.1 那 7 步校验的顺序，也不新增校验步骤**。失败结果与上游返回 `InvalidParameter` 的映射一致，都是 `INTERNAL`（`spec/03-接口契约.md` §5.1、`modules/M06-生成编排.md` §5）。种子数据合法时该分支永不触发，`ERR-03` 覆盖的是上游路径。

### 5.5 长度断言的区间与「只 warn 不阻断」

- 区间：`[200, 1200]` 字符（`spec/07-验收标准.md` §2.2 `PR-07`；`spec/05-Prompt工程.md` §9 的目标区间 300–900 是其建议子集）；
- 超限行为：`logger.warn({ job: 'generate', era: era.code, sceneId: scene.id, length, ... }, 'prompt length out of range')`，**不 throw、不改写文本、不截断**。

不阻断的理由：长度是**质量信号而非正确性条件**，截断既会破坏 `PR-08` 的确定性、又会把种子数据的问题掩盖成静默降级，而一次越界只是一次额度消耗——正确的修复路径是「改 `spec/era-scene-seed.json` → 递增 `packVersion` → `pnpm seed`」。

### 5.6 版本常量的落点与落库映射

`src/server/prompt/versions.ts` 只导出两个常量（第三个 `seed-v1` / `0.6` 见 §9 待定决策 1）：

```ts
// src/server/prompt/versions.ts
export const PROMPT_TEMPLATE_VERSION = "tpl-v1";
export const ANCHOR_PROMPT_VERSION = "anchor-v1";
```

| 常量 | 值 | 落库位置 | 谁写入 |
|---|---|---|---|
| `PROMPT_TEMPLATE_VERSION` | `tpl-v1` | `generations.template_version` | `generationService` 取 `buildPrompt(...).templateVersion` 原样写入 |
| `eras.pack_version` | `v1` | `generations.era_pack_version` | `generationService` 取 `era.packVersion` |
| `scenes.pack_version` | `v1` | `generations.scene_pack_version` | `generationService` 取 `scene.packVersion` |
| `ANCHOR_PROMPT_VERSION` | `anchor-v1` | `identity_anchors.prompt_version`，**不入 `generations`** | 由锚点提取任务（ticket 06）写入 |

关键点：**`anchor-v1` 不写进 `generations` 行**。`generations` 只有 `template_version` / `era_pack_version` / `scene_pack_version` 三个版本列（`spec/01-领域模型与数据库.md` §3.9），没有承载锚点提取 prompt 版本的列，也**不新增**；锚点版本经 `generations.anchor_id` → `identity_anchors.prompt_version` 间接可查，而 `anchor_text` 已全文嵌在 `generations.prompt` 里，即使锚点行被重新提取，历史 prompt 也不会变。

版本递增规则（`spec/05-Prompt工程.md` §7.2）：改动 `template.ts` 的段落结构或常量文本 → 递增 `PROMPT_TEMPLATE_VERSION`；改动 `eras.prompt_pack` / `eras.constraint_pack` → 递增 `eras.pack_version`；改动 `scenes.space_pack` → 递增 `scenes.pack_version`。`generations` 行冗余保存了这三个当时的值，因此历史结果永远可复现。`prompt_override` 无独立版本列，随 `era_scene_profiles` 行一起变更。

---

## 6. 边界与错误

错误码表必须与 `spec/03-接口契约.md` §5 的「错误码 → 触发条件 → 用户可见文案」逐字符一致。

| 错误码 | HTTP | 触发条件 | 用户可见文案 |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | 未登录或会话过期访问 `GET /api/config/era-scene` | 请先登录 |
| `INVALID_PARAM` | 400 | `eraCode` / `sceneId` 在 `eras` / `scenes` 中不存在，或该行 `is_active = 0`（`spec/03-接口契约.md` §3.5） | 选择有误，请重新选一下 |
| `ANCHOR_NOT_CONFIRMED` | 409 | 锚点虽为 `succeeded` 但 `anchor_text` 为空——`spec/01-领域模型与数据库.md` §2.1 的不变量被破坏，锚点实际不可用 | 需要先确认"这就是他"，才能开始生成 |
| `INTERNAL` | 500 | `eras.default_size` 解析失败，或总像素低于 3,686,400 / 高于 16,777,216 / 宽高比越界（内部拼装 bug，`spec/03-接口契约.md` §5.1） | 出了点小问题，请重试 |

边界行为（不报错）：

| 情况 | 行为 |
|---|---|
| `(era_code, scene_id)` 未命中 `era_scene_profiles` | `profile = null`，走「年代包 + 场景包」两层拼装，**不报错**（`spec/05-Prompt工程.md` §2.1） |
| `profile.confidence < 0.6` | 服务端照常返回；提示由前端使用响应中的 `confidenceHintThreshold` 决定（`spec/07-验收标准.md` §2.1 `DB-04`） |
| `eras` / `scenes` 为空（未跑 `pnpm seed`） | `GET /api/config/era-scene` 返回 `200` + 空数组；问题由 `GET /api/health` 的 `db.eras` 计数暴露（`spec/03-接口契约.md` §3.7） |
| `samplePhotoId` / `coverPhotoId` 为 `null` 或指向已软删除的照片 | 对应 URL 字段下发 `null`，前端降级为纯文字卡片 |
| 拼装后长度越界 | 仅 warn，任务照常入队（§5.5） |

---

## 7. 配置与环境变量

只使用 `spec/08-本地开发指南.md` §4 已声明的变量，**不新增**：

| 变量 | 默认 | 本模块的用法 |
|---|---|---|
| `DATABASE_PATH` | `./data/app.db` | 经 `getDb()` 间接使用；`config.ts` 不直接读该变量 |
| `PROVIDER` | `mock` | 写入 `params_json.provider`，值域 `mock` / `real` |
| `ARK_IMAGE_MODEL` | `doubao-seedream-5-0-lite-260128` | 写入 `generations.model` |
| `WATERMARK_DEFAULT` | `false` | 写入 `params_json.watermark` |

不在本模块读取：`ARK_API_KEY`（只有 `RealArkProvider` 读）、`ARK_VISION_MODEL`（锚点提取与复核用）、`ARK_BASE_URL`、`ARK_TIMEOUT_SECONDS`、`STORAGE_DIR`、`MAX_UPLOAD_MB`、`WORKER_STALE_MINUTES`、`JOB_TIMEOUT_SECONDS`、`SMS_PROVIDER`、`DEV_LOGIN_CODE`、`GENERATION_DEFAULT_COUNT`、`AIGC_IMPLICIT_MARKER`。

`params_json.outputFormat` 固定 `"png"`，因为 `spec/08-本地开发指南.md` 未定义对应变量，本期不发明新变量（见 §9 待定决策 4）。

---

## 8. 测试要点

### 8.1 单元测试清单（`pnpm test`，vitest）

| 测试 | 断言 |
|---|---|
| `build.test.ts` · 段落完整 | 遍历 20 组 `(eraCode, sceneId)`：`prompt` 含全部 6 个标签 |
| `build.test.ts` · 顺序 | 6 个标签的 `indexOf` 严格递增 |
| `build.test.ts` · 否定词 | 20 组 `prompt` 对 `/不要|禁止|no\s|without/` 命中数为 0 |
| `build.test.ts` · 防美化 | 20 组均含 `不做任何美化` 与 `减龄` |
| `build.test.ts` · E1 黑白 | E1 的 5 组含 `黑白` |
| `build.test.ts` · 跨年代词 | E3 / E4 的 10 组不含 `胶片` |
| `build.test.ts` · 长度 | 20 组 `length ∈ [200, 1200]`；越界时 mock `logger.warn` 被调用且不抛错 |
| `build.test.ts` · 确定性 | 同输入连调两次 `prompt` 全等、`promptHash` 全等且为 64 位小写十六进制 |
| `build.test.ts` · 组合微调分支 | `promptOverride === null` 不含 `【组合微调】`；非 `null` 必须含，且段落在末尾 |
| `build.test.ts` · 分隔符 | `prompt` 中段间为 `\n`；含换行的 `anchorText` 其内部换行原样保留（不折叠、不 trim） |
| `config.test.ts` · 过滤与排序 | `readEraSceneConfig()` 返回 4 / 5 / 20 行；`is_active = 0` 的行不出现；`eras.sort_order` 为 1,2,3,4 |
| `config.test.ts` · 无 N+1 | 用计数器包住 `db.prepare`，断言总执行次数为 3 |
| `config.test.ts` · 样片降级 | `sample_photo_id` 指向已软删除行时 `samplePhotoId` 为 `null` |
| `generationService.test.ts` · size | `2048x2048` 通过；`1024x1024`、`1000x3686` 抛 `INTERNAL`；`params_json.size` 为原始字符串 |
| `generationService.test.ts` · 版本落库 | `template_version='tpl-v1'`、`era_pack_version=era.packVersion`、`scene_pack_version=scene.packVersion` |
| `generationService.test.ts` · 锚点为空 | `anchorText` 为空 → `ANCHOR_NOT_CONFIRMED` |

### 8.2 对齐的检查项（逐条说明由哪些代码保证）

| 检查项 | 由什么代码保证 |
|---|---|
| `PR-01` 6 个固定段落标记齐全 | `template.ts` 定义 6 个 `SECTION_*` 常量；`build.ts` 的 `sections` 字面量无条件包含 6 段（`anchorText` / `promptPack` / `spacePack` / `constraintPack` 为空时也不漏段，空串只让该段变短） |
| `PR-02` 段落顺序固定 | `build.ts` 的 `sections` 是**字面量数组**，无 `sort`、无按需重排、无 `Set` |
| `PR-03` 无否定词 | `template.ts` 两段常量不含否定词；`spec/era-scene-seed.json` 的 `promptPack` / `constraintPack` / `promptOverride` 全部为正面化文本（`DB-03` 覆盖 `constraint_pack`，`PR-03` 额外覆盖 `prompt_pack` 与 `promptOverride`）；`build.ts` 不注入额外文本 |
| `PR-04` 含 `不做任何美化` 与 `减龄` | `AGE_PRESERVE_CLAUSE` 逐字符取自 `spec/era-scene-seed.json` 的 `agePreserveClause`，含「不做任何美化、磨皮与减龄处理」；该段在 `build.ts` 中不可删除、无开关 |
| `PR-05` E1 含 `黑白` | E1 的 `prompt_pack` / `constraint_pack` 已含「黑白影调 / 全画面无彩色 / 黑白照片」；`template.ts` 两段常量不含 `彩色`。⚠ 字面判定与 E1 `constraint_pack` 中的「不出现任何彩色元素」有冲突，见 §9 待定决策 2 |
| `PR-06` E3/E4 不含 `胶片` | `REALISM_ANCHOR` 与 `AGE_PRESERVE_CLAUSE` 均不含「胶片」（`spec/05-Prompt工程.md` §5 的明确设计意图：写实锚定词自身不含「胶片」以避免跨年代污染）；E3/E4 的 `prompt_pack`、`constraint_pack` 与 4 个 `promptOverride` 也不含 |
| `PR-07` 长度 ∈ [200, 1200] | 由种子数据与模板常量的实际长度满足，`build.test.ts` 断言；运行期 `build.ts` 只 warn（§5.5） |
| `PR-08` 同输入两次拼装一致 | `build.ts` 是纯函数：无时间、无随机、无环境变量、无数据库、无文件 IO；`promptHash` 用 `createHash("sha256")` 对 `prompt` 全文计算，无盐、无时间戳 |
| `PR-09` `prompt_override` 为 NULL 时无 `【组合微调】` 段 | `build.ts` 的 `if (override !== null && override.trim() !== "")` 分支：为 `null` 时既不 push 段落也不 push 空串，`prompt` 尾部无残留换行；非 `null` 时 `SECTION_PROFILE` 必须出现 |

### 8.3 关联的 B 层检查项

- `API-06`：`/api/config/era-scene` 响应不含四个 prompt 字段（§4.2）；
- `API-02`：响应形状由 `src/shared/types.ts` 的 zod schema 断言（§2）；
- `DB-05`：`eras.default_size` 总像素 ≥ 3,686,400（§5.4 的前置假设）；
- `ERR-03`：size 不合法的上游错误被映射为 `INTERNAL`（§5.4 与上游路径保持同一结果）；
- `E2E-03`：`generations.prompt` 与 `buildPrompt` 输出逐字符相等——`build.ts` 是唯一拼装入口（`spec/04-技术基线与目录结构.md` §3.1 第 3 条），`generationService` 只做转写不做加工。

---

## 9. 非目标与待定决策

### 9.1 非目标（本期不做，留扩展位）

| 不做项 | 原因 | 扩展位 |
|---|---|---|
| 用户可编辑 prompt | 与「用户只选年代与场景」定位冲突 | `generations.prompt` 已全文落库，只读展示零成本 |
| LLM 自动改写年代包 | 不可控，破坏 `PR-08` 的确定性 | `buildPrompt` 是唯一入口，可在其后插一步 |
| 负向提示词通道 | 模型不支持 `negative_prompt` | 若换模型，`buildPrompt` 增加一个返回字段即可，正文规则不变 |
| 组合级 A/B 分流 | 本期无流量 | `prompt_hash` 已落库 |
| 配置管理后台 | 本期配置变更只走 `pnpm seed` | `spec/era-scene-seed.json` 是权威副本，后台只是它的另一个写入口 |
| 自定义场景描述 | 引入 prompt 注入与审核成本（`spec/00-总纲.md` §6.2） | `scenes` 可插入行，`prompt_override` 结构已支持 |

### 9.2 待定决策

1. **`GET /api/config/era-scene` 的 `version` 与 `confidenceHintThreshold` 在数据库中无对应列**。`spec/era-scene-seed.json` 有顶层 `version`（`seed-v1`）与 `confidenceHintThreshold`（`0.6`），但三张配置表都没有承载它们的地方（`era_scene_profiles.confidence` 是逐行值，不是阈值）。这两个字段不能省：`pages/P00-设计基准与路由.md` §10 用响应的 `version` 作为模块级缓存的 key，`confidenceHintThreshold` 是前端判断「温和提示」的唯一依据。最小实现：在 `versions.ts` 中定义两个常量并注明来源文件，由 `pnpm check:acceptance` 增加一条断言比对常量与 `spec/era-scene-seed.json` 的同名字段；`version` 变更时必须与种子文件同批更新，否则前端缓存 key 会与数据不符。彻底方案（新增迁移与一张配置元数据表）超出本 ticket 预算，留待后续。
2. **`PR-05` 的字面判定与 E1 种子文本冲突**。`spec/07-验收标准.md` §2.2 `PR-05` 要求 E1 的 5 组 prompt「不含 `彩色`（除"无彩色"这一固定表述）」，但 E1 的 `constraint_pack` 含「不出现任何**彩色元素**」，不匹配「无彩色」这一豁免。两种收口方式：(a) 检查实现把豁免正则放宽为 `无彩色|不出现任何彩色元素`；(b) 修改 `spec/era-scene-seed.json` 的 E1 `constraintPack` 措辞并把 `packVersion` 递增到 `v2`。本文件倾向于 (a)——「不出现任何彩色元素」是正面化改写表（`spec/05-Prompt工程.md` §3）里「E1 出现彩色」一行的标准表达，改文本会丢掉这层对应关系。需在 ticket 18 落地时确认。
3. **样片 / 封面 URL 与取图端点的鉴权冲突**。`sampleUrl` / `coverUrl` 指向 `/api/photos/:id/file`（`spec/03-接口契约.md` §3.4），而该端点要求照片属于当前用户。样片是运营资产而非用户照片，因此 `seed-v1` 下这两个字段**一律为 `null`**（种子本就未填 `sample_photo_id` / `cover_photo_id`）。若将来要真正上线样片，需要给取图端点加一条「公开样片」豁免路径。
4. **`params_json.outputFormat` 无环境变量来源**。`spec/08-本地开发指南.md` §4 未定义输出格式开关，本期固定 `"png"`。若将来要支持 `jpeg`，必须先补环境变量文档再改代码。
5. **单元测试文件位置未在任何文档中约定**。本文件按「与被测源码同目录的 `*.test.ts`」书写；实际 include 规则由 ticket 01 的 `vitest` 配置决定，落地时若不同，只改路径不改断言。
6. **`era_scene_profiles` 无 `sort_order` 列**，本文件按 `(era_code, scene_id)` 排序。若将来需要自定义矩阵展示顺序，需要新增一列（属于表结构变更，必须回到 `spec/01-领域模型与数据库.md` 并新增迁移）。

---

## 10. 与上游文档的差异

| 上游（`docs/raw/AIGC_PRD.md` 或 `.scratch/` 实测脚本） | 本方案（以本文件为准） | 依据 |
|---|---|---|
| §5.1「最终 prompt = 身份锚点 + 年代质感包 + 场景空间包 + 写实锚定词 ± 组合微调」，共 4 段 | 7 段：`【身份锚点】【年龄保真】【年代】【场景】【质感】【年代一致】【组合微调】`，模板版本 `tpl-v1` | `negative_prompt` 不可用，年龄保真与年代一致性必须各占一个独立正向段落（`README.md` §0.3、`spec/05-Prompt工程.md` §4） |
| §5.2 把「典型服装道具」写在年代轴里；§5.3 把「典型道具」写在场景轴里（如 S4 的搪瓷杯、暖水瓶，S5 的自行车、军绿挎包） | 场景包保持**跨年代中性**，年代特定物件一律下沉到 `era_scene_profiles.prompt_override`；`.scratch/seedream_era_scene.js` 中带「搪瓷杯、暖水瓶、老式电视」「自行车、公文包、军绿挎包」的 S4/S5 空间包**不采用** | `spec/05-Prompt工程.md` §6：同一场景包必须在 E1 与 E4 下都成立，否则年代包会被场景包污染 |
| §7.1 的写实锚定词含「摄影质感」「轻微的对焦不实」「[年代专属颗粒与画质描述]」「[年代]年的影像质感」等占位与泛化描述 | 定稿为 `spec/era-scene-seed.json` 的 `realismAnchor`：「真实照片，随手拍的生活照，自然皮肤纹理，可见毛孔与细纹，真实肤色不均，柔和的对比度，构图自然不刻意」 | 占位符无法逐字符复现（`PR-08`）；raw 版还带 `[年代]` 插值，会把年代信息重复注入 E3/E4 的【质感】段；定稿版不含「胶片」字样，避免跨年代污染（`spec/05-Prompt工程.md` §5） |
| `.scratch/seedream_era_scene.js` 的【年代一致】段写作「…必须属于 ${era.label} 或更早；…**不出现**该年代之后才有的物件」 | 改用 `eras.constraint_pack` 的**全正面化**文本，脚本里的「不出现…」写法作废 | 实测脚本的该句属负向表达；`PR-03` 要求全 prompt 对 `/不要|禁止|no\s|without/` 零命中（`spec/07-验收标准.md` §2.2） |
