# T08 · 年代场景配置读取与 Prompt 拼装引擎

| 项 | 值 |
|---|---|
| 阶段 | M2 |
| 依赖 | `T02` |
| 必读文档 | `modules/M05-年代场景配置与Prompt拼装.md`、`spec/05-Prompt工程.md` |
| 检查项 | `PR-01`–`PR-09`、`E2E-03`、`API-06` |

## 1. 目标
三张配置表安全下发给前端（不含任何 prompt 正文），并把「身份锚点 + 年代包 + 场景包 + 模板常量 + 组合微调」拼成唯一可复现的 prompt，落 `generations` 的拼装列。

## 2. 不做（边界）
- 不写配置表（唯一写入路径是 `pnpm seed`）；不内联 prompt 文本（`spec/05-Prompt工程.md` §1 铁律）；不下发 prompt 正文。
- 不做生成任务状态机 / worker / 复核（归 `tickets/T09`、`tickets/T11-生成后复核与内容安全审核.md`）；不新增错误码与环境变量。

## 3. 要交付的文件
| 路径 | 新建/修改 | 职责 | 依据 |
|---|---|---|---|
| `app/api/config/era-scene/route.ts` | 新建 | `requireUser()` → `readEraSceneConfig()` → 组装响应 | `spec/03-接口契约.md` §3.4 |
| `src/server/db/repositories/config.ts`（+ `src/server/db/repositories/config.test.ts`） | 新建 | 三张表只读查询、`snake_case` → `camelCase`，固定 3 条 SQL 无 N+1 | `modules/M05-年代场景配置与Prompt拼装.md` §3.1 |
| `src/server/prompt/build.ts`、`src/server/prompt/template.ts`（+ `src/server/prompt/build.test.ts`） | 新建 | `buildPrompt` 唯一入口、7 个段落标签常量、`tpl-v1` | `spec/05-Prompt工程.md` §2、§2.2 |
| `src/server/prompt/versions.ts` | 修改 | 追加 `seed-v1` 与三个种子顶层常量 | `spec/05-Prompt工程.md` §2.2 |
| `src/server/domain/generationService.ts` | 修改 | `default_size` → `params_json.size` 与 ≥ 3,686,400 的像素校验 | `modules/M05-年代场景配置与Prompt拼装.md` §5.2 |
| `src/shared/types.ts` | 修改 | `EraOption` / `SceneOption` / `EraSceneProfile` / `EraSceneConfig` DTO 与 zod | `spec/03-接口契约.md` §4 |

## 4. 实现要点
1. 段落顺序固定、段间单个 `\n`、段内原文不 trim；`prompt_override` 为 `null` 或全空白时整段省略；`promptHash = sha256(prompt, 'utf8')`（小写十六进制）。
2. `buildPrompt` 是纯函数：不得读库 / 读文件 / 读环境变量，不得出现 `Date` 与 `Math.random`（`PR-08` 要求同组合两次拼装完全一致）。
3. `samplePhoto` 三态透传：`EraOption.sampleUrl` / `SceneOption.coverUrl` / `EraSceneProfile.sampleUrl` 原样透传，`null` 时前端降级为纯文字（`modules/M05-年代场景配置与Prompt拼装.md` §4.1）。
4. 响应白名单：不含 `promptPack` / `spacePack` / `constraintPack` / `promptOverride`（`API-06`）；长度断言只 `logger.warn`，不阻断、不截断。

## 5. 完成判定
```bash
pnpm test && pnpm check:acceptance
```
- `PR-01`–`PR-09`（20 组断言见 `modules/M05-年代场景配置与Prompt拼装.md` §8）与 `API-06`；`DB-06`（`version` == 种子顶层 `version`）随本条 `SEED_VERSION` 与种子对齐后转绿；通用项见 `spec/07-验收标准.md` §5。

## 6. 待定决策
无。
## Comments

- [待定决策] prompt 长度有三套阈值——`spec/05-Prompt工程.md` §9"建议 300–900、低于 200 不足、高于 1200 稀释" vs `spec/07-验收标准.md` `PR-07`"[200, 1200]"，而 `spec/09-施工纪律.md` D5 禁止改数字阈值。→ 只保留一处定义（建议以 `PR-07` 为唯一阈值），`spec/05` §9 改为引用。
- [待定决策] `realismAnchor` / `agePreserveClause` / `confidenceHintThreshold` / `version` 是 `spec/era-scene-seed.json` 的顶层字段，不属于任何表，`pnpm seed` 也不写它们；而 `spec/03-接口契约.md` §3.4 要求下发 `realismAnchor` 与 `confidenceHintThreshold`。→ 明确由 `src/server/prompt/versions.ts` 导出这三个常量（与 `SEED_VERSION` 同处），并加 A 层断言"与种子文件顶层字段逐字符一致"。
- [待定决策] `modules/M05-年代场景配置与Prompt拼装.md` §5.1 同时声明"模板全文以 `spec/05-Prompt工程.md` §2 为权威副本"与"两者不一致时以种子文件为准"，加上 `template.ts`，同一份 prompt 正文有三个候选事实源。→ 定为一个：代码 `template.ts` 为唯一事实源，`spec/05` 只写结构，并加等值断言。
