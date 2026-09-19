# T02 · 数据层：迁移、schema 与种子数据

| 项 | 值 |
|---|---|
| 阶段 | M1 |
| 依赖 | `T01` |
| 必读文档 | `spec/01-领域模型与数据库.md`、`spec/02-schema.sql`、`spec/era-scene-seed.json` |
| 检查项 | `DB-01`–`DB-08` |

## 1. 目标
一次 `pnpm migrate && pnpm seed` 后 16 张表就位、4/5/20 条配置资产可读、固定 `DEV_USER` 可用（`spec/08-本地开发指南.md` §3.2），全部 SQL 收敛在 repository 层。

## 2. 不做（边界）
- 不实现任何业务 service / 端点；三张配置表**只由种子写入**（`DB-08`）。
- 不新增表 / 字段 / 索引（结构以 `spec/02-schema.sql` 为唯一落地，冲突以 `spec/01-领域模型与数据库.md` §3 为准）；不引入 ORM；不启用 SQLite 外键级联。

## 3. 要交付的文件
| 路径 | 新建/修改 | 职责 | 依据 |
|---|---|---|---|
| `migrations/001-init.sql` | 新建 | 与 `spec/02-schema.sql` 逐字符一致的首个迁移 | `spec/04-技术基线与目录结构.md` §2 |
| `src/server/db/connection.ts`、`src/server/db/migrate.ts` | 新建 | `getDb()` 单例（`journal_mode=WAL`、`foreign_keys=OFF`）；按序执行迁移 + `schema_migrations` 记账 | `spec/04-技术基线与目录结构.md` §4.3 |
| `src/server/db/seed.ts` | 新建 | 读 `spec/era-scene-seed.json` 幂等 upsert 三张配置表 + `DEV_USER` | `spec/08-本地开发指南.md` §2–§3.2 |
| `src/server/auth/session.ts` | 新建 | **鉴权桩**：`getSessionUser()` / `requireUser()` 返回种子 `DEV_USER`、不查 cookie（真实会话由 `tickets/T12` 在**同一路径**替换，见 §4 第 4 条） | `spec/08-本地开发指南.md` §3.2、`spec/03-接口契约.md` §1.2 |
| `src/server/db/repositories/*.ts` | 新建 | 12 个 repository 的骨架与函数签名 | `spec/04-技术基线与目录结构.md` §2 |

## 4. 实现要点
1. 重复跑 `pnpm migrate` / `pnpm seed` 必须幂等；`seed` 结束断言 `eras=4`、`scenes=5`、`era_scene_profiles=20`，不符**非零退出**（`spec/08-本地开发指南.md` §2）。
2. repository 入参为原子值 / DTO，返回 camelCase 领域对象；`*_json` 列在边界 `JSON.parse` / `stringify` + zod 校验（`spec/04-技术基线与目录结构.md` §4.3）。
3. 所有写操作包在 `db.transaction(...)`；配置表只允许 `SELECT` 与种子 upsert；`DEV_USER` 必须已实名（`verified_at` 非空），供 `tickets/T03`–`tickets/T11` 使用。
4. **M1/M2 鉴权桩**（`src/server/auth/session.ts`）：`getSessionUser()` / `requireUser()` 直接返回种子 `DEV_USER`（`id` 取种子行），**不读 cookie、不查 `sessions`**；`DEV_USER` 已实名，故实名门槛一并通过。存在期：`tickets/T03`–`tickets/T11` 的受保护端点全部依赖它；替换出口是 `tickets/T12` §4 第 5 条——T12 **覆盖同一路径**为真实会话实现，桩随之消失。

## 5. 完成判定
```bash
pnpm migrate && pnpm seed     # 退出码 0，重复执行仍为 0
pnpm test                     # DB-01–DB-05、DB-08 全绿
```
- `DB-01`（`sqlite_master` 16 表集合）、`DB-02`（4/5/20）、`DB-03`（否定词零命中）、`DB-04`（低置信恰 5 组）、`DB-05`（`default_size` 总像素）、`DB-08`（源码扫描无配置表写入）。
- `DB-06`（`version` 等于种子）与 `DB-07`（`/api/health` 计数）依赖 `tickets/T01` 的 `/api/health` 与 `tickets/T08` 的配置端点，本条只保证数据侧成立；通用项见 `spec/07-验收标准.md` §5。

## 6. 待定决策
无。
## Comments

- [已收口] M1/M2 的鉴权桩归本条：`src/server/auth/session.ts` 落 `getSessionUser()` / `requireUser()` 桩（返回种子 `DEV_USER`、不查 cookie，见 §3、§4 第 4 条），`tickets/T12` 在**同一路径**替换为真实会话并写明出口条件与回归项（含 `API-03`）（本目录 `07-依赖边与所有权`）。
- [实现记录] 交付：`migrations/001-init.sql`（与 `spec/02-schema.sql` 逐字符一致，`cmp` + `sha256` 校验）；`db/connection.ts`（`getDb()` 单例，连接级 PRAGMA 在事务外设 `journal_mode=WAL` / `foreign_keys=OFF` / `synchronous=NORMAL`；`busy_timeout` 取构造器 `timeout:5000`）、`db/migrate.ts`（`schema_migrations` 记账、按文件名序、单文件单事务）、`db/seed.ts`（读 `spec/era-scene-seed.json`，zod 校验后幂等 upsert 三张配置表 + `DEV_USER`，结束断言 4/5/20 不符则抛错非零退出）、`db/reset.ts`、`auth/session.ts` 鉴权桩、12 个 repository。验收：`pnpm typecheck` / `pnpm lint` 零错误；`pnpm test` **25** 用例全绿（新增 8 条覆盖 `DB-01`–`DB-05`、`DB-08` 与幂等）；`pnpm migrate && pnpm seed` 退出码 0 且重复执行仍为 0；`pnpm db:reset` 退出码 0；`pnpm check:docs`（17 断言）/ `pnpm test:docs`（50 用例）全绿。
- [待定决策 → 已定] **`db:reset` 的落点**：`spec/08-本地开发指南.md` §6 与 `tickets/T01` 的交接要求该脚本，但本条 §3 未列文件，故新增 `src/server/db/reset.ts` 并同步 `spec/04-技术基线与目录结构.md` §2 代码树（加 `reset`）。影响面：新增一文件与一行文档。
- [实现记录] **repository 的完成度**：12 个文件落「行类型 + `snake_case`→`camelCase` 映射 + 核心函数」的 SQL 底座（`config.ts` 按 `modules/M05-年代场景配置与Prompt拼装.md` §3.1 的 7 个符号落地）；`photos` / `anchors` / `generations` / `consents` / `usage` 等的专用查询与事务编排按各自 ticket 以「修改」补齐。
- [待定决策] **`DB-01`–`DB-08` 的执行层**：`spec/check-registry.json` 把 8 项标为 B 层（`assertedBy: pnpm check:acceptance`），但 `scripts/acceptance.ts`（`tickets/T01` §3 声明的骨架）尚不在仓库，而本条 §5 的完成判定写 `pnpm test`。本条按工单以 vitest 断言 `DB-01`–`DB-05`、`DB-08`；B 层脚手架接线为待补环节（`DB-06` / `DB-07` 另依赖 `tickets/T08` 的配置端点与 `/api/health`）。影响面：`scripts/acceptance.ts` 的落地者需把这 8 项接上。
- [待定决策] **`/api/health` 的 `db` 计数**：`tickets/T01` §Comments 期望 T02 落表后接上 `db.ok`，但本条 §5 明确「只保证数据侧成立」，`app/api/health/route.ts` 不在本条 §3 交付清单、`tickets/T09` 已声明以「修改」写 `worker` 字段。故本条未改 health，端点当前仍报 `eras/scenes/profiles = 0`（`DB-07` 未接线）。影响面：需与 `db` 三计数一并接上。
- [实现记录] **两轴评审收口**（`/code-review`，Standards + Spec）：① JSON 列读取补 zod 边界校验（新增 `src/server/db/json.ts` 的 `parseJsonColumn` / `parseRequiredJsonColumn`，覆盖 `style_json` / `quality_json` / `features_json` / `params_json` / `input_photo_ids` / `reference_photo_ids` / `meta_json` / `result_json`），满足 `spec/04-技术基线与目录结构.md` §4.3；② repository 写函数统一 `db.transaction(...)`，`consentsRepo.ensureActive` 的「读判 → 写」用 `.immediate()`（`spec/04` §4.3）；③ `isMain` 三处重复抽到 `src/server/db/cli.ts`，`sessions` / `loginCodes` 列清单抽为 `COLUMNS` 常量；④ `connection.ts` 去掉与构造器 `timeout` 等价的 `PRAGMA busy_timeout`。新增的 `cli.ts` / `json.ts` 已同步 `spec/04` §2 代码树。
- [待定决策] **repository 的「新建」归属**：`modules/M04-身份确认与授权.md` 写 `consents.ts` / `audit.ts`「由 `tickets/T07` 新建」、`modules/M05` 写 `config.ts` 归 `tickets/T08`，而本条 §3 声明 `repositories/*.ts` 由 T02 建「骨架与函数签名」——同一文件被两条工单都标「新建」。`pnpm check:docs` 的 `single-new` 因本条用通配、下游用字面路径（按字面比较）而未拦下。本条按 §3 建文件并落 SQL 底座，下游以「修改」扩充。影响面：各工单「新建/修改」列的口径，需人工统一。
