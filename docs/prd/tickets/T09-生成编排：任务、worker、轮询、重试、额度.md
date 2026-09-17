# T09 · 生成编排：任务、worker、轮询、重试、额度

| 项 | 值 |
|---|---|
| 阶段 | M2 |
| 依赖 | `T08` |
| 必读文档 | `modules/M06-生成编排.md`、`spec/03-接口契约.md` §2 |
| 检查项 | `SEC-04`、`SEC-05`、`ERR-01`、`ERR-02`、`ERR-04`、`ERR-05`、`E2E-04`、`E2E-09` |

## 1. 目标
生成的 8 步校验序列、单事务入队与额度预扣、worker 的拉取 / claim / 心跳 / 回收 / 超时 / 自动重试就位；`POST /api/generations`、`GET /api/generations/:id`、`POST /api/generations/:id/retry` 与 `GET /api/health` 的 worker 字段可用。

## 2. 不做（边界）
- 不做 Seedream 调用、结果转存与隐式标识（归 `tickets/T10-Seedream生图调用与结果转存.md`）；本条交付 worker 机制与编排，`src/jobs/handlers/generate.ts` 由 T10 落成。
- 不做复核与审核（归 `tickets/T11-生成后复核与内容安全审核.md`）；`readQuota()` 归 `tickets/T12-账号、会话与额度.md`；不新增端点 / 字段 / 错误码 / 环境变量。

## 3. 要交付的文件
| 路径 | 新建/修改 | 职责 | 依据 |
|---|---|---|---|
| `app/api/generations/route.ts`、`app/api/generations/[id]/route.ts`、`app/api/generations/[id]/retry/route.ts` | 新建 | 三端点：入队 / 读任务 / 新建行重试 | `spec/03-接口契约.md` §3.5 |
| `src/server/domain/generationService.ts` | 修改 | `createGeneration` 的 8 步序列与单事务写入、`retryGeneration` 新建行 | `modules/M06-生成编排.md` §5.1–§5.2、§5.7 |
| `src/jobs/worker.ts`、`src/jobs/registry.ts` | 修改 | 三表拉取、claim、心跳、启动回收、超时与自动重试 | `modules/M06-生成编排.md` §5.4–§5.5 |
| `src/server/db/repositories/usage.ts` | 新建 | `usage_counters` 的 UPSERT、预扣与回滚 SQL | `modules/M06-生成编排.md` §5.6 |
| `src/server/db/repositories/generations.ts` | 新建 | `generations` 全部 SQL | `spec/03-接口契约.md` §2.3 |
| `src/server/db/repositories/audit.ts` | 修改 | `generation.create` / `generation.finish` 审计 | `spec/03-接口契约.md` §2.3 |
| `app/api/health/route.ts` | 修改 | `worker.alive` / `worker.lastSeenAt` | `spec/03-接口契约.md` §3.7 |

## 4. 实现要点
1. `POST /api/generations` 的校验顺序即契约，逐条对齐 `spec/03-接口契约.md` §3.5 的 8 步；第 1–7 步在事务**外**先跑（快速失败、不产生写）。
2. 终态判定 `n === requestedCount ? 'succeeded' : n > 0 ? 'partial' : 'failed'`；三种终态都写 `finished_at` 与 `audit_logs('generation.finish')`；`partial` **不**自动重试。
3. 入队事务按 `modules/M06-生成编排.md` §5.2 的固定顺序执行：`checkActiveByUser` → 额度复查与预扣 → `INSERT` → 写审计；事务用 `db.transaction(...).immediate()`（`BEGIN IMMEDIATE`），**排他性检查必须在 `INSERT` 之前**——否则刚插入的 `queued` 行会把自己数进去，每次首次生成都误报 `GENERATION_IN_PROGRESS`。
4. 自动重试只对 `PROVIDER_TIMEOUT` / `PROVIDER_ERROR` / `STORAGE_ERROR`（含映射到它的 `SQLITE_BUSY`）且 `n === 0` 且 `attempt < 1`；`attempt` 只在重试时自增，不在 claim 阶段自增；worker handler 不得抛 `AppError`。

## 5. 完成判定
```bash
pnpm test && pnpm check:acceptance
```
- `SEC-04`（额度不足 → 429 且不产生 `generations` 行）、`SEC-05`（已有非终态 → 409）、`ERR-01`（`fixtures/ark/timeout.json` 回放超时 → `PROVIDER_TIMEOUT`、`attempt=1`）、`ERR-02`（重启回收 `running` → `queued`）、`ERR-05`（`fixtures/ark/model-not-open.json` → `PROVIDER_ERROR`、不可重试、`attempt=0`）、`ERR-04`（停 worker 后 `worker.alive=false`）；通用项见 `spec/07-验收标准.md` §5。
- 本条的 `ERR-01` 需要 worker 才能端到端复现（`tickets/T05` 只覆盖 `mapArkError` 的逐条映射）。

## 6. 待定决策
按 `modules/M06-生成编排.md` §9 回填 `## Comments`：`partial` 不自动重试、`JOB_TIMEOUT_SECONDS` 与 `ARK_TIMEOUT_SECONDS` 同为 120s 的关系、`params_json.outputFormat` 固定 `png`。
## Comments

- [已收口] 拉取顺序已改为**轮转**（`spec/04-技术基线与目录结构.md` §4.6 现在写着：worker 每次迭代**只从一张表取一行**、取完把游标推进到下一张，取不到行也推进，三张表循环——固定顺序每次迭代都从第一张开始，会让排在最后的表永远排不上）（本目录 `05-生成与转存契约` 收口）。
- [待定决策] `tickets/T09` §4 第 4 条原要求 `GET /api/generations/:id` 的 `results` 按 `photos.deleted_at IS NULL` 过滤（依据 `modules/M08` 的"结果行延后清理"）——该前提已改：软删阶段即物理删除 `generation_results`（对齐 `spec/01-领域模型与数据库.md` §2.3），故该过滤与不变式一并作废，不再实现。
