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

- [待定决策] 三条上游能力断言在本仓库的实测证据里无法确认，而它们决定了本条的实现与 `spec/05-Prompt工程.md` §7.2 的"可复现"口径：① `seed` 参数是否被 `images/generations` 接受并回传（`docs/火山引擎接口文档.md` §1.2 的完整参数表里没有 `seed`，`.scratch/api_image_response.json` 的 `data[0]` 只有 `{url,size}`，`.scratch/seedream_era_scene.js` 也从不设置或读取它）；② `image` 多图参考（身份一致性的主要承载）是否真实可用，以及 ≤14 张 / ≤30MB / 6000×6000 的上限——留存的端到端实测③是纯文生图，从未带过参考图；③ `negative_prompt` 是否确实被 lite 拒绝。→ 在本条真机调用时顺手做这三条最小实测并回填结论：`seed` 若不支持/不回传，`generation_results.seed` 保持 `NULL` 且不再声称逐位复现；多图若不可用，须回改 `spec/00-总纲.md` §3 的链路铁律与 `spec/03-接口契约.md` §3.5 的 `reference_photo_ids`。
- [待定决策] `spec/08-本地开发指南.md` §1.5 实测"请求 `2048x2048`，实际返回 `1920x1920`"。→ `generation_results` 的 `width` / `height` 与 `photos.width` / `photos.height` 必须取**转存后图片的实际像素**（用 `sharp` 探），不得直接写请求的 `size`。
