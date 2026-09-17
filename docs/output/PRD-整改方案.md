# 「回家照相馆」PRD 整改方案（已执行）

> **状态：已执行完毕。** 8 个挂点全部落地，另修复 3 处超出计划的周边缺陷（见 §3）。
> 自动化校验通过：孤儿检查项 0、双属检查项 0、幽灵检查项 0。
> 缺陷底账见 `docs/output/PRD-评审报告.md`；校验脚本见 `.scratch/check-docs.mjs`。

---

## 1. 已落地的挂点

| 挂在 | 改了什么 | 状态 |
|---|---|---|
| **T02 前** | `spec/02-schema.sql` + `spec/01`：`prompt_reverse_jobs` 补 `started_at` / `attempt` / `error_code`；**所有 PRAGMA 移出迁移文件**（SQLite 禁止事务内切 `journal_mode`），改由 `getDb()` 在事务外设置并加 `busy_timeout=5000`；`spec/04` §4.3 补 `BEGIN IMMEDIATE` 与 `SQLITE_BUSY` 映射；`spec/03` §5.1 新增 `SQLITE_BUSY → STORAGE_ERROR`（可重试，不新增错误码） | ✅ |
| **T03 前** | worker 任务来源由两张表改为**三张表**（`spec/04` §4.6，并删去"SQLite 单进程"前提）；上传阶段审核改为**阻断式**（`spec/03` §3.2 + M01 + M07：`reject` → 落库后立即软删 + `content_reviews` + `audit_logs(moderation.reject)` + `422 CONTENT_REJECTED`）；`content_reviews` 统一为**每阶段无论 verdict 都写一行** | ✅ |
| **T08 前** | `PR-04` 归属由 M03 改为 **M05**（`spec/07` §2.2、M03 §8、T06/T08 表头） | ✅ |
| **T09 前** | `ERR-01` 期望值改正为 **`PROVIDER_TIMEOUT`**、归属收到 T09；`spec/03` §3.5 的 retry 错误集补全为 5 个；`seed` 措辞软化——保留可空列，`spec/05` §7.2、`spec/00` §3、`README` §4.3 的"历史结果永远可以复现"改为"可重新提交复现"，**省掉当前的上游实测**（挂到 T10） | ✅ |
| **T11 前** | 被审核拒的张**不写 `generation_results`、不计入 `n`**，终态由 M06 的 `n` 公式决定（M07 §1/§3/§5.6/§6/§10 全量改写）；`spec/07` `E2E-05` 与 `SEC-08` 口径同步为 "= `n`" | ✅ |
| **T12 前** | `SEC-07` 拆号：授权留痕 → 新号 **`SEC-09`**（`spec/06` §2、`spec/07` §2.5、M04 §8、T07 表头）；`SEC-07` 保留 `devCode` 语义并改正为 **`POST /api/auth/code` + `SMS_PROVIDER=console`**；删掉不存在的 `U14`（`spec/06` §2 与 §4） | ✅ |
| **T14 前** | `spec/era-scene-seed.json` 的 `samplePhoto` **全部改为 `null`**（实测 `docs/output/` 相关 3 张均为 2048×2048 = 各年代 `defaultSize`，是模型生成输出，按 D12 不得充当样片）；`spec/04` §2、`spec/08` §7/§9、M05、`pages/P02` §6、T14、`tickets/README` 同步为"`public/samples/` 本期为空，前端降级为纯文字卡片" | ✅ |
| **T20 前** | prompt 阶段 `target_id` hack **保留现状**（记为已决策）；`DELETE` 恒返回 **200**（按 `spec/09` §1 权威序以 `spec/03` §1.5 为准，改 M08 §5.2/§5.3/§6）；`generation_results` **软删阶段即物理删除**（对齐 `spec/01` §2.3，改 M08 §3.3/§3.4/§5.3）；`82 项` → **65 项**（`spec/07` §3、T20 ×4、`tickets/README`） | ✅ |

---

## 2. 检查项数量的变化（84 项 = B 层 65 + A 层 19）

| 动作 | 变化 |
|---|---|
| `SEC-07` 一号两义 | 拆为 `SEC-07`（`devCode`）+ **`SEC-09`**（授权留痕），B 层 +1 |
| `ERR-01` 原本覆盖"不可重试分支"但期望值写错 | 改为覆盖超时分支；**新增 `ERR-05`** 覆盖 `PROVIDER_ERROR` / 不可重试 / `attempt=0`，B 层 +1 |
| 计数口径 | 原写"82 项全绿"，实际是 B 层 63 + A 层 19；现为 **B 层 65**（`pnpm check:acceptance`）+ **A 层 19**（`pnpm test`）= 84 |

`spec/07` §2 的标题、§3 的示例输出（`65 passed`）与 `tickets/README`、T20 的口径已统一。

---

## 3. 三处超出原计划的修正（透明披露）

1. **P0-6 排他性检查顺序**——原挂点表漏了这一项（属"不定就写不了代码"一类，与 `ERR-01` 同级）。已修：M06 §5.2 明确事务内顺序为 `checkActiveByUser → 额度复查/预扣 → INSERT → 审计`，排他检查**必须在 `INSERT` 之前**；`db.transaction(...).exclusive()` 改为 `.immediate()`；T09 §4 同步。
2. **新增 `ERR-05`**——只改 `ERR-01` 的期望值会让"不可重试分支"彻底失去检查项，故按 `spec/07` §2 的注册机制新增一条。
3. **一致性扩展**（由已决语义直接推出、非新增决策）：M03 §8 的 `PR-04` 循环引用与误挂的 `E2E-09`；M05 §5 与 `config.test.ts` 的样片断言；`pages/P02` §6 的样片来源；M08 §6 的"purged 后重复删除 → 200"；M09 §5 的 claim / 失败 SQL 与字段映射（补 `started_at` / `error_code` / `attempt`）；M06 §5.9④ 与 M07 的 `reject` 语义；T12 表头的 `SEC-04` 去重（改由 T09 拥有，正文改为依赖说明）。

---

## 4. 自动化校验结果

用 `.scratch/check-docs.mjs` 对全库跑了一遍 `check:docs` 的原型规则：

```
registry: 84 | B: 65 | A: 19
by family: API:9 CMP:5 DB:8 DEL:4 E2E:10 ERR:5 MARK:7 PR:9 PRE:12 REV:3 RN:3 SEC:9
UNOWNED (0): (none)
DOUBLE-OWNED (0): (none)
PHANTOM (0): (none)
```

- **无孤儿**：每个检查项都有且只有一个 ticket 认领（脚本会展开 `PR-01`–`PR-09` 这类区间写法，并把表头标 `无专属项` 的回归条目排除在 ownership 之外）。
- **无双属**：修掉了 `API-06`（原 T08/T13/T14 三方）、`SEC-01`（T07/T16）、`SEC-04`（T09/T12）、`API-03`/`API-04`/`DEL-01`/`ERR-04`（T03/T13/T17）共 7 处。
- **无幽灵**：ticket 表头声明的 ID 全部存在于 `spec/07`；`U14` 已彻底移除。
- 剩余的 2 条 `STALE` 命中在 T01 的一条 `## Comments` 里，是描述缺陷时的历史引用（`U14`、"82 项"），非实际残留。

---

## 5. 延后项的去向

本轮**不改**的 41 条记录已逐条写入 19 个 ticket 的 `## Comments`（`spec/09` §5.1 规定的通道），每条都带"问题 → 选哪个方案 → 理由 → 影响面"：

```
T01(1) T02(1) T03(2) T04(3) T06(3) T07(2) T08(3) T09(2) T10(2) T11(2)
T12(1) T13(1) T14(1) T15(2) T16(2) T17(4) T18(4) T19(1) T20(4)
```

其中 P1 全部（M02 依赖的 repository 函数、M03 的 12 键矛盾、HEIC 语义、prompt 长度三套阈值、`realismAnchor` 的落地、前端三处互斥、历史页漏删除、F4 入口位置…）、P2 全部，以及四条有明确时限的：**T10 的三条上游实测**、**T01 的 `check:docs`**、**T02 的 `requireUser()` 桩**、**T17 的 `pages/P04` 负路径（须在 T15–T17 之前完成）**。

---

## 6. 现在可以开工

前置等待为 0：T01 不依赖上述任何一项改动。从 T01 起按 `tickets/README.md` 的依赖图逐条取票，每格修改已挂在对应 ticket 上（§1），延后项在各自 ticket 的 `## Comments` 里（§5）。
