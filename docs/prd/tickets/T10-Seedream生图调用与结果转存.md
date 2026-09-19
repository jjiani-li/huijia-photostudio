# T10 · Seedream 生图调用与结果转存

| 项 | 值 |
|---|---|
| 阶段 | M2 |
| 依赖 | `T09` |
| 必读文档 | `modules/M06-生成编排.md` §5、`spec/03-接口契约.md` §3.5、`spec/06-合规与风控.md` §3 |
| 检查项 | `E2E-05`–`E2E-08`、`CMP-01`、`CMP-03`、`CMP-04`、`MARK-01`–`MARK-07`（A 层 · `pnpm test`） |

## 1. 目标
worker 拿到 `generations` 任务后调上游生图、逐张**立即转存**、写隐式标识、落 `photos(kind='generated')` 与 `generation_results`，并按产出张数写终态与回滚额度。

## 2. 不做（边界）
- 不做内容审核与年代复核的判定（归 `tickets/T11-生成后复核与内容安全审核.md`）；本条只在逐张流程里留出调用点。
- 不做前端结果页与下载（归 `tickets/T17-前端：生成结果、历史与下载.md`）；不新增端点 / 字段 / 环境变量；不得为标识写入引入新依赖。

## 3. 要交付的文件
| 路径 | 新建/修改 | 职责 | 依据 |
|---|---|---|---|
| `src/jobs/handlers/generate.ts` | 新建 | `runGenerateJob`：上游调用 → 逐张转存 → 落两张表 → 终态与额度回滚 | `modules/M06-生成编排.md` §5.9 |
| `src/server/images/mark.ts`（+ `src/server/images/mark.test.ts`） | 新建 | `AIGC_MARKER` 与 `markGeneratedImage()`：PNG `tEXt` / JPEG EXIF | `spec/06-合规与风控.md` §3.1–§3.2 |
| `src/server/ark/real.ts`、`src/server/ark/mock.ts`、`src/server/ark/types.ts` | 修改 | 多图请求（`sequential_image_generation`）、生图 fixture 回放，以及 `generateImage(request, signal?)` 的可中止入口 | `modules/M06-生成编排.md` §5.9 |
| `src/server/db/repositories/generations.ts`、`src/server/db/repositories/photos.ts` | 修改 | `generation_results` 插入与 `photos(kind='generated')` 落库 | `spec/01-领域模型与数据库.md` §3.9–§3.10 |
| `fixtures/images/*`、`scripts/acceptance.ts`、`src/server/db/repositories/audit.ts` | 修改 | 生图回放样本与 `E2E-05`–`E2E-08` 执行；`photo.mark` 审计 | `spec/08-本地开发指南.md` §5.1 |
| `src/jobs/registry.ts` | 修改 | 注册 `generate` handler 与 `generations` 的超时兜底（`PROVIDER_TIMEOUT` 的 requeue-or-fail） | `spec/04-技术基线与目录结构.md` §4.6 |

## 4. 实现要点
1. 转存按 `spec/06-合规与风控.md` §3.3 的固定序列执行（下载 → 探宽高 → 写隐式标识 → 原子落盘 → 插行），本文件不复述；本条只补两处取值：`photos.width` / `height` 用 `probeImage()` 的**实测值**（不得写请求的 `size`），`photos.bytes` 取标识写入**之后**的长度（见第 2 条）。。
2. `photos.bytes` 必须取标识写入**之后**的长度（否则 `E2E-06` 失败）；标识写入失败**不**置任务失败，写 `mode='failed'` 审计并照常交付未标记文件。
3. `ordinal` 从 0 连续递增；`count > 1` 时请求体带 `sequential_image_generation: 'auto'` 与 `max_images`；签名 URL（86400s）必须立即转存，**不得入库**。
4. 终态、额度回滚与 `audit_logs('generation.finish')` 按 `modules/M06-生成编排.md` §5.3、§5.6 在同一事务内完成；handler 捕获全部异常，不抛 `AppError`。

## 5. 完成判定
```bash
pnpm test && pnpm check:acceptance
```
- `MARK-01`–`MARK-07`（A 层，`pnpm test`，判定见 `spec/07-验收标准.md` §2.9）；`E2E-05`–`E2E-08`（张数 / `ordinal` / 磁盘字节 / `sha256` 互异 / 额度）、`CMP-01`（标识可读回且值等于 `AIGC_MARKER`）、`CMP-03`（`photo.mark` 行数等于生成张数、无 `mode='failed'`）、`CMP-04`（关开关后仍写审计且文件读不到标识）；通用项见 `spec/07-验收标准.md` §5。

## 6. 待定决策
无。
## Comments

- [已收口] 三条未验证的上游能力已集中登记在 `spec/07-验收标准.md` §6 的诚实边界表（每条标 **未验证**，含证据位置与"若结论为否怎么降级"），本 ticket 的 `## Comments` 是它们的**唯一挂起处**；同时把三处复述删掉——`README.md` §4.3、`spec/00-总纲.md` §3、`spec/05-Prompt工程.md` §7.2 现在只写「可重新提交复现 / 不承诺逐位相同的出图」并引用 §6。要推翻或确认它们，走 `.scratch/upstream-capability-verification/issues/01-上游能力探针与能力台账.md` 的真机探针（本目录 `05-生成与转存契约` 收口）。
- [已收口] 宽高一律取**转存后实测值**：`modules/M06-生成编排.md` §5.9 ③ 写明「用 `sharp.metadata()` 探转存后的实际像素、**不得**写请求的 `size`」，`spec/01-领域模型与数据库.md` §3.4 的 `photos.width` / `height` 按 `kind='generated'` 同口径声明（DTO 的 `GenerationResult.width` / `height` 由 `photos` 透出）。原引用 `spec/08-本地开发指南.md` §1.5 是笔误——那条实测记录在 `docs/火山引擎接口文档.md` §1.3、§1.5（请求 `2048x2048` 实际回 `1920x1920`）（本目录 `05-生成与转存契约` 收口）。

### 落地记录（本次交付）

**交付文件**：`src/server/images/mark.ts`（+ `mark.test.ts`，`MARK-01`–`MARK-07`）、`src/jobs/handlers/generate.ts`（`runGenerateJob`）、`src/jobs/registry.ts`（注册 `generate` handler + `generations.onTimeout`）、`src/server/db/repositories/generations.ts`（`insertResult` / `requeueForRetry`）、`src/server/ark/{mock,real,types}.ts`、`scripts/acceptance.ts`。

**闸门结果**：`pnpm test` 217 项通过（新增 `mark.test.ts` 10 项）；`pnpm check`、`pnpm check:docs`、`pnpm test:docs` 全绿；`pnpm migrate && pnpm seed && pnpm check:acceptance` 退出码 0（无失败、无跳过；本次新增的 9 项 `E2E-05`–`E2E-08`、`CMP-01`、`CMP-03`、`CMP-04`、`ERR-01`、`ERR-05` 全绿）。跑完 `data/` 无 `worker-heartbeat`、`storage/` 无残留文件、`generations` / `generation_results` / `photos` / `audit_logs` / `usage_counters` 全部回到 0 行。

- **mock 的确定性选图已改为 `(hash(prompt) + ordinal) % 3`**（原为 `hash(prompt | ordinal) % 3`）：后者只保证「同一输入同一输出」，不保证 `count ≥ 2` 时前两张落在不同 fixture 上，`E2E-07`（≥2 张 `sha256` 不同）因此是概率性的。改后前两张必然不同，`spec/08-本地开发指南.md` §5.1 的 mock 行为规则同步改口径。
- **`ArkProvider.generateImage` 增加可选 `signal?: AbortSignal`**（`src/server/ark/types.ts`）：worker 的 `JOB_TIMEOUT_SECONDS` 竞速只会 `controller.abort()`，不接 `signal` 的上游调用会继续在飞；`real.ts` 把它桥到内部超时 `AbortController`（中止 → `AbortError` → `PROVIDER_TIMEOUT`），`mock.ts` 在 sleep 后查一次 `signal.aborted`。这是 ticket §3 表外的一处接口补充，已记入该表。
- **`mark.ts` 额外导出 `readPngText(buf, keyword)`**：与 `markPng` 共用同一套块解析，供 `MARK-01` / `MARK-05` 与 `CMP-01` / `CMP-04` 读回关键字值；`§3.1` 规定的两个导出（`AIGC_MARKER`、`markGeneratedImage`）形状不变。PNG 的 CRC-32 走 `zlib.crc32`（Node ≥ 20.15/22，本机 24），不可用时回落查表实现。
- **`photo.mark` 三态**：`AIGC_IMPLICIT_MARKER=false` → `{implicit:false, mode:'off', format}`；写入抛错 → 照常交付未标记字节 + `{implicit:false, mode:'failed', format, reason}`；成功 → `{implicit:true, format, marker}`。`CMP-03` 断言行数 == 张数且无 `failed`，`CMP-04` 断言关开关后仍写审计且文件读不到标识。
- **T11 的钩子**：`generate.ts` 的逐张循环里，转存后（`produced.push` 之前）留了注释块，写明 `moderateResult()`（硬闸门，`reject` 中止该张及后续张的转存、写 `content_reviews(stage='result')` 与 `moderation.reject`）与 `eraReview()`（软标注，回填 `era_check_json` / `age_delta`，失败留 `NULL` 并 warn）的调用位置。**未实现、未写 `content_reviews`**，`insertResult` 的 `era_check_json` / `age_delta` 恒 `NULL`。
- **`ERR-01` / `ERR-05` 由本条补齐**（T09 只覆盖了 worker 机制的 `ERR-01` 口径，端到端复现留在本条）：用 `getArk()` 的 mock 单例 `setFailure(...)`，`ERR-01` 驱动 handler 两次（第一次 `queued`/`attempt=1`，第二次 `failed`/`PROVIDER_TIMEOUT`/`attempt=1`），`ERR-05` 一次即 `failed`/`PROVIDER_ERROR`/`attempt=0`（跑完还原 `setFailure(null)`）。为此 handler 的失败分支把 `mapArkError().retryable` 与 worker 的 `isAutoRetryable()`（零产出 + 瞬时码集合 + `attempt < 1`）**合并判定**——`ModelNotOpen` 落 `PROVIDER_ERROR` 但 §5.8 标注不可重试，只看错误码会把 `ERR-05` 变成 `attempt=1`。
- **接受度脚本的配额**：T09 用例留下的预扣没有回滚，DEV_USER 默认额度（20）会被后续用例撞满，故 T10 用例段临时把 `daily_image_quota` 抬到 10000 并登记还原（与既有的 `usage_counters` 快照回滚同一套自带清理）。

### 两轴评审收口（`/code-review`，Standards + Spec，基线 `f7b9988`）

1. **循环导入**：`registry.ts` 一度 `import { settleJobFailure } from './worker'`，与 `worker → registry → handlers/generate → worker` 形成环。已把 `AUTO_RETRY_ERROR_CODES` / `AUTO_RETRY_MAX_ATTEMPT` / `isAutoRetryable` / `settleJobFailure` 从 `worker.ts` 拆到新文件 `src/jobs/settle.ts`，三处（worker / registry / generate）都从它导入；`spec/04` §2 代码树补 `settle`。环已断。
2. **`generations.onTimeout` 的配额泄漏与竞态**：原实现无条件走 `settleJobFailure(produced: 0)`，其 `failed` 分支只写 `updateStatus('failed')`——**不回滚额度、不写 `generation_results` / `generation.finish`**（违反 `M06` §5.3/§5.6），且对已由 handler 自落终态的行会二次覆盖（handler 挂起被 abort 后仍可能完成并 finalize）。改为 `generate.ts` 导出 `failTimedOutGeneration(id)`：**只对仍 `running` 的行生效**；可重试 → `requeueForRetry`，否则 `commitTerminal`（终态 + 结果行 + 回滚 + `generation.finish` 同一事务）。`registry` 的 `onTimeout` 指向它。
3. **零产出重试的漏网**：原先只有 `generateImage` / 读参考图**抛错**才会走 `attempt<1 → requeue`；逐张转存全部失败（`n=0`、`STORAGE_ERROR`）不会抛出到外层 catch，于是直接落 `failed`，漏掉 `spec/04` §4.6 的「零产出 + 瞬时码 → 重试一次」。已把重试判定移到逐张循环**之后**统一做：`produced.length === 0 && lastFailure.retryable && isAutoRetryable(...)` → `requeueForRetry`，两种失败来源共用同一判据。
4. **契约分歧收在 `spec/`**：§4.6 的「错误码瞬时集合」与 `M06` §5.8 的逐条 `可重试` 列对 `ModelNotOpen`（落 `PROVIDER_ERROR`）互相矛盾，`ERR-05` 要求 `attempt=0`。已在 `spec/04-技术基线与目录结构.md` §4.6 写明「逐条可重试性以 `modules/M06-生成编排.md` §5.8 的 `可重试` 列为准，不一致时按该列收窄」，不再只留在 ticket 记录里。

收口后复跑：`pnpm test` 217 全绿；`pnpm check` 零错误；`pnpm check:docs` 17 断言 / `pnpm test:docs` 50 用例全绿；`pnpm check:acceptance` 仍 **37 passed**（`E2E-05`–`E2E-08`、`CMP-01/03/04`、`ERR-01/05` 全绿）。
