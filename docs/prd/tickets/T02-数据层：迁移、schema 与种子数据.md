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
