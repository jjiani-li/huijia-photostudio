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
| `src/server/ark/real.ts`、`src/server/ark/mock.ts` | 修改 | 多图请求（`sequential_image_generation`）与生图 fixture 回放 | `modules/M06-生成编排.md` §5.9 |
| `src/server/db/repositories/generations.ts`、`src/server/db/repositories/photos.ts` | 修改 | `generation_results` 插入与 `photos(kind='generated')` 落库 | `spec/01-领域模型与数据库.md` §3.9–§3.10 |
| `fixtures/images/*`、`scripts/acceptance.ts`、`src/server/db/repositories/audit.ts` | 修改 | 生图回放样本与 `E2E-05`–`E2E-08` 执行；`photo.mark` 审计 | `spec/08-本地开发指南.md` §5.1 |

## 4. 实现要点
1. 转存顺序固定：上游 `data[].url` 下载 → `markGeneratedImage()` → `LocalStorageProvider` 先写 `.tmp` 再 rename → 插 `photos(kind='generated', bytes=marked.length)` → 插 `audit_logs('photo.mark')`（`spec/06-合规与风控.md` §3.3）。
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
