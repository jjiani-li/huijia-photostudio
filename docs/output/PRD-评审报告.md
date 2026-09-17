# 「回家照相馆」PRD 评审报告

> **评审对象**：`docs/prd/`（46 个文件 / 约 5,000 行）：`README.md` + `spec/` 11 份 + `modules/` 9 份 + `pages/` 4 份 + `tickets/` 21 份
> **对照物**：`docs/raw/AIGC_PRD.md`（上游需求）、`docs/火山引擎接口文档.md` + `ark-examples/` + `.scratch/`（上游实测证据）
> **评审方式**：全文通读 + 交叉引用核对 + 上游证据核验 + 抽样技术验证（PNG 尺寸、SQL seed 内容计数、schema 逐表核对）
> **评审日期**：2026-09-17

---

## 1. 总体结论

### 1.1 一句话

**这是一套结构远优于行业平均的 PRD——层次分明、契约先行、检查项可执行、每个工程决策都写了理由；但它目前不能直接开工，必须先做一次上游能力实测和一轮契约勘误。** 现有缺陷不是"写得不够细"，而是**"同一件事被写了很多遍，于是开始互相打架"**，以及**"把未验证的上游能力当成了既成事实写进了数据库 schema"**。

### 1.2 三个判断

| 判断 | 结论 | 依据 |
|---|---|---|
| 颗粒度是否够 AI 编码？ | **够**。`改哪些文件 / 读写哪些表 / 调哪些接口 / 怎么算做完` 四问基本都在文档里有答案，检查项 ID 体系是同类文档中少见的亮点 | 见 §7.1 |
| 能否直接开工？ | **不能**。存在 8 项阻断级缺陷，AI 工人在 T05–T10 区间必然撞墙，且部分检查项**在数学上不可能变绿** | §3 |
| 核心承诺是否有支撑？ | **两条最核心的承诺缺证据**："可复现"建立在 `seed` 参数上，而全仓库没有任何证据显示该参数被 API 接受或返回；"像本人"建立在多图参考上，而留存的端到端实测**没有一次带过参考图** | 附录 A |

### 1.3 量化画像

| 指标 | 值 |
|---|---|
| 文档文件数 | 46（`spec/07` 声明 46，与实际一致） |
| 验收检查项总数 | 82（A 层 19 + B 层 63，但文档口径写成"82 项全绿"，见 P1-1） |
| 检查项 ID 冲突 / 无归属 / 不存在 | 7 类，共 11 处（附录 B） |
| 同一契约被重复定义的处数 | 错误码表 ×9、worker 规则 ×3、`content_reviews` 写入形状 ×2、`cascaded` 计数 ×2、阈值类常数 ×3 处以上 |
| 上游能力断言总数（附录 A） | 16 项：9 项已验证、3 项间接／部分验证、4 项**无任何实测证据**、1 项**与证据直接冲突** |
| 被删除／收窄且未记入差异表的上游需求 | 12 项，其中 9 项完全未记录（附录 C） |

### 1.4 值得保留的优点（评审时不要误伤）

1. **检查项 ID 体系 + `[mock]/[real]` 路径标签**：让"完成"有了唯一自动化判据，这是整套文档最有价值的发明。
2. **权威性顺序明确**（`spec/09` §1）：冲突时上位否定下位，且有 `D1`–`D12` 禁令表。
3. **反常识决策都写了理由**：如"不做 F3 因为全部实测结论都来自单人场景"、"样片可为 null 因为不挂图比挂错图好"——这类判断是 PRD 质量的真实体现。
4. **`spec/02-schema.sql` 与 `spec/01` 表字典严格对应**，逐表核对无缺失（16 张表与 `DB-01` 一致）。
5. **`spec/era-scene-seed.json` 的 20 组组合数据完备**：`DB-04` 声明的"低置信恰好 5 组"实测成立（E3-S1 0.55、E4-S1 0.2、E3-S2 0.35、E1-S4 0.5、E4-S5 0.4）。

---

## 2. 系统性问题（根因）

下面 7 条是上面那些具体缺陷的**共同成因**。只修具体条目而不修根因，第二轮还会长出同类问题。

### S1 · 检查项注册表是"人肉索引"，没有任何机器校验

**现象**：`U14` 被 `spec/06` §2 引用但 `spec/07` 里不存在；`SEC-07` 在 `spec/06` §2 是"授权留痕"、在 `spec/07` §2.5 是"`devCode`"（一号两义）；`API-06` 被 `spec/07` §2.3 归给 M08、却被 M05 与 M08 同时认领；`PR-04` 定义在 M05 能产出的产物上却归属 M03；`E2E-03` / `E2E-10` / `SEC-06` 没有任何 ticket 认领。

**最佳实践方案**：把检查项从散文变成**数据**。

- 新增 `docs/prd/spec/check-registry.json`：每条 `{ id, layer, owner, path, assertedBy, tickets[] }`。
- 新增 `pnpm check:docs`（纯静态、无需 worker），断言：
  1. ID 全局唯一；2. 每个 ID 恰有 1 个 owner；3. `tickets[]` 非空（无孤儿检查项）；4. 每个 ticket 表头声明的 ID 都存在于注册表（无幽灵检查项）；5. 每个 ticket 交付表里标"新建"的文件全仓库恰出现一次；6. `spec/07` §2 的条目数 == 注册表条数 == 脚本打印的通过数。
- 把 `check:docs` 加为 `spec/07` §2 的第 0 项（B 层前置）。
- **收益**：一次性消灭本报告约 12 条具体缺陷，并让"82 vs 63"这类问题永远不可能再出现。

### S2 · 同一契约被 9 个模块各自复述一遍

**现象**：错误码表在 `spec/03` §5 定义一次，又在 M01–M09 各写一遍（9 份）；worker 的 claim / 心跳 / 回收 / 自动重试在 `spec/04` §4.6、M06 §5.4–5.5、M08 §5.1/§5.3、M09 §5 各写一遍，**已经互相矛盾**（M06 说三张任务表，`spec/04` §4.6 说两张，M09 又说 M06 只覆盖两张）；`content_reviews` 的写入条件 M01 说"默认 pass"、M06 说"仅 reject 时写"、M07 说"每阶段都写"。

**最佳实践方案**：**引用，不要复制**（restate 是 drift 的唯一来源）。

- 规则写进 `spec/09` 新增条款：**跨模块契约（错误码、状态机、worker 契约、审计动作、检查项 ID）只允许在原文档出现一次，其他文档一律写"见 `path` §x.y"，且不得复述表体**。
- 具体动作：删除 M01–M09 的 §6/§7 错误码表体，改为"本模块新增的错误码（如有）：…；其余见 `spec/03` §5"；把 worker 契约收进 `spec/04` §4.6 一处，M06/M07/M08/M09 只写各自的 handler 特化。
- 把"九处错误码表互相一致"从人工核对变成 `check:docs` 的一条规则（扫描 `modules/*.md` 中的错误码表标题，命中即报错）。

### S3 · 上游能力未实测，就被写成了数据库列

**现象**：`generation_results.seed`、`generations` 的"全部参数落库以保证可复现"、`eras.default_size` 的上限与宽高比校验、`image` ≤14 张 / ≤30MB 这四条，在 `docs/火山引擎接口文档.md` 的参数表中**要么不存在 `seed`，要么只有结论行而无任何实测报错或返回佐证**（附录 A）。

**最佳实践方案**：建立**能力台账 + 开工闸门**。

- 新增 `docs/prd/spec/10-上游能力台账.md`，一行一能力：`能力 | 需要的断言 | 实测状态（已验证/未验证/被否证） | 证据（文件:行） | 若不成立的影响面 | 降级方案`。
- 闸门规则（写入 `spec/09` 禁令表）：**任何未标注"已验证"的能力，不得出现在 schema 列、不得出现在验收检查项、不得出现在对外承诺里**。允许先用 `params_json` 承载实验性参数，实测通过后再升格为列。
- 立刻要跑的最小实测（一次性、约 30 分钟）：① 带 `seed` 调一次生图，看是否 400、响应是否回传 seed、同 seed 两次是否同图；② 带 1 张参考图（= PRD 的核心链路）跑一次 E2×S1；③ 试 `negative_prompt` 是否真的被拒。三条结论决定 §3 的 P0-1 与 P0-2 的修法。

### S4 · 契约级冲突被塞进 ticket 的「待定决策」

**现象**：`spec/09` §5.4 明确要求"若该问题**阻塞**完成判定，则停下…不要自己发明字段绕过"，但实际写法相反——

| 冲突 | 位置 | 被记为 |
|---|---|---|
| `DELETE` 幂等返回 200 vs purge 后 404 | `spec/03` §1.5 ↔ M08 §5.3 | M08 §9 待定 2、T13 §6 |
| `generation_results` 软删阶段保留 vs 立即物理删除 | `spec/01` §2.3 ↔ M08 §3.3 | M08 §9 待定 4 |
| 任务来源两张表 vs 三张表 | `spec/04` §4.6 ↔ M06 §5.4 | M09 §10 |
| `prompt_reverse_jobs` 缺三列 | `spec/03` §3.8 ↔ `spec/02-schema.sql` | T18 §6、M09 §10 |
| 上传阶段审核的阻断语义 | M01 §9.3 ↔ M07 §5.6 | M01 §9 待定 3 |

**最佳实践方案**：**契约冻结闸门**。

- 规则：凡涉及表 / 列 / 端点 / 错误码 / 状态机的分歧，**必须在开工前回到 `spec/` 之一定稿并更新所有引用方**；ticket 的 `## Comments` 只能记"实现细节级"的待定，不能记契约级。
- 落地形式：在 `spec/00` 增加"契约冻结清单"（端点 × 状态机 × 表 × 错误码），每条注明"已冻结/待定"，**待定项 >0 则不得开工**。
- 加一个 `spec/CHANGELOG.md`：契约每次变更追加一行（谁改、为什么、影响哪些检查项），替代散落在各 ticket 的待定记录。

### S5 · 手写的交付物清单必然过期

**现象**：`82 项全绿`、"从 `docs/output/` 拷 6 张真实样片"、"`spec/04` §2 的 11 个 repository"、"46 个文件"、"8 个 fixture"——这些都是手写常数，其中**至少 5 处已经与实际不符**（见 P1-1、P0-7、P1-13）。

**最佳实践方案**：把手写常数换成**推导出来的值**。检查项数由 `check-registry.json` 派生；文件清单由 `check:docs` 校验存在性；repository / fixture 清单改为"以目录为准 + 脚本断言"，文档只写目录名。

### S6 · 合规与情感安全的"负路径"没有 owner

**现象**：产品最高风险是"结果一看就是假的 → 二次伤害"（上游 §2.4、§12），但：

- `spec/06` §9.2 要求"首次进入生成结果页前展示一次温和说明"，`pages/P00` §5.1 也标了"含首次情感安全提示"，而 **`pages/P03` 全文没有一处提到它**，`tickets/T17` 的目标里也没有——合规硬约束**无实现、无检查项**。
- 结果页只有 `喜欢 / 不喜欢`（`pages/P03` §6），**没有"这不是他"这条出路**，也没有回到"换一张照片"的路径；唯一能反映产品失败的信号被丢掉了。
- 上游 §12 的"侵权投诉与下架通道"被删除（`spec/06` §10 记为"不存在"），但 `spec/00` §8 与 `README` §0 的差异表**没有记录这次删除**；同时 `pages/P00` §5.2 还写着一句用户无法兑现的承诺"我们不会把你的照片用在别的地方"。
- `spec/06` §5.1 规则 3 描述"显式吊销入口（见 M04 §5.5）"，而 M04 §5.5 明说"**不新增端点**"——用户可以授权，但没有任何途径撤销。

**最佳实践方案**：

- 新增 `docs/prd/pages/P04-失败与情绪安全路径.md`，把"负路径"提升为一等旅程：提取失败 / 质量不可用 / 生成失败 / 结果不像 / 超时 / 额度用尽，每种给出**文案 + 动作 + 落点 + 检查项**。
- 情感安全提示：在 `spec/06` §9.2 明确触发口径（建议"每个会话首次进入结果页一次"，状态放在 `SiteHeader` 的内存态，不写 `localStorage`，以遵守 `pages/P00` §6 的禁令），并在 `pages/P03` 与 `tickets/T17` 落下落点与检查项。
- 结果页增加第三个反馈值（如 `user_feedback = -2` 表"不像他"），并定义它的消费方（`pnpm check:blind` 的 report 里给出聚合口径）。
- 补一条静态的申诉/联系方式到 `pages/P00` §5.2（零成本，且让那句承诺可兑现）。

### S7 · 与上游的差异表不完整，导致"悄悄收窄"

**现象**：`spec/00` §8 只记录了 F1/F3/F4 三项改写，而实际被收窄或删除的上游要求至少 10 项（附录 C）。最危险的不是"不做"，而是**"做了但没记录"**：例如上游 F2 验收"无年代穿帮"，现在 `pages/P03` §6 变成"`reject` 的结果图不隐藏、不阻断下载"——**从"不得出现"降级为"标注 + 仍可交付"**，而这条恰好是产品的最高优先级约束之一。

**最佳实践方案**：建立**需求追溯矩阵（RTM）**。

- 新增 `docs/prd/spec/11-需求追溯矩阵.md`：一行一条上游要求 → `处置（采纳 / 改写 / 不做 / 降级）` → `理由` → `落点（spec/module/page/ticket）` → `检查项` → `残余风险`。
- `spec/00` §8 与 `README` §0 只保留"最重要的 5 条"，其余指向 RTM。
- 更新规则：任何"降级"（不是"不做"）都必须同时给出补偿措施，否则不得降级。

---

## 3. P0 —— 开工前必须修复（阻断级）

> 判定标准：不修则 AI 工人**无法完成该 ticket 的完成判定**，或**必然产出错误实现**。

### P0-1 「可复现」建立在无证据的 `seed` 参数上

- **位置**：`README.md` §4.3、`spec/00` §3 铁律 ⑦、`spec/01` §3.10、`spec/03` §3.5、`spec/05` §7.2 规则 3
- **问题**：文档承诺"所有生图任务参数（prompt / seed / …）必须落库以保证可复现"、"历史结果永远可以复现"。但 `docs/火山引擎接口文档.md` §1.2 自称完整的请求参数表里**没有 `seed`**；`.scratch/api_image_response.json` 的顶层是 `model / created / data / usage`，`data[0]` 只有 `{url, size}`，**没有 seed 字段**；实际发起调用的 `.scratch/seedream_era_scene.js` 构造 body 时**从不设置 seed**，解析响应时**从不读取 seed**。
- **影响面**：`generation_results.seed` 列恒 `NULL`；`GenerationResult.seed` 字段空转；`spec/05` §7.2 的"可复现"是虚假承诺；若验收将来加 seed 断言会直接红。
- **修复**（按实测结果二选一）：
  - 若 API 接受 `seed` 并回传 → 在 `spec/10-上游能力台账.md` 记"已验证 + 证据"，保留列。
  - 若 API 不接受或不回传 → **删掉 `generation_results.seed` 列与 `GenerationResult.seed` 字段**，把"可复现"改写为可验证的表述："同一组输入（prompt + 参考图 + 模型 + size）落库后可重新提交复现"，并在 `spec/05` §7.2 规则 3 明确删去"永远可以复现"。
  - 无论哪种，都必须**先实测再定稿**（见 S3）。

### P0-2 `prompt_reverse_jobs` 缺三列，导致 F4 的状态机无法实现

- **位置**：`spec/02-schema.sql` §96–109、`spec/01` §2.4 与 §3.15、`spec/03` §3.8、`modules/M09` §5
- **问题**：`spec/03` §3.8 要求该任务"超时与回收规则同 §2.2"（依赖 `started_at`）、"可自动重试 1 次"（依赖 `attempt`）、`error = { code, message }`（依赖 `error_code`）。三列**都不存在**。M09 §10 与 T18 §6 把它记为待定——但这是契约级缺失（违反 `spec/09` §5.4），不是实现细节。
- **修复**：新增 `migrations/002-prompt-reverse-jobs.sql` 补 `started_at TEXT` / `attempt INTEGER NOT NULL DEFAULT 0` / `error_code TEXT`，同步 `spec/01` §2.4 与 §3.15、`spec/02-schema.sql`（或直接合并进 001，因为尚未开工），并删除 M09 §10 / T18 §6 的对应待定项。

### P0-3 `ERR-01` 的期望值使其**在数学上不可能通过**

- **位置**：`spec/07` §2.7（`ERR-01`）↔ `modules/M06` §5.8 与 §8 末尾
- **问题**：`spec/07` 断言"`status='failed'`、`error_code='PROVIDER_ERROR'`、`attempt=1`"；而 M06 明确"`ERR-01` 用 `fixtures/ark/timeout.json` 走超时后重试 1 次的路径"，超时映射为 **`PROVIDER_TIMEOUT`**（M06 映射表第 143 行）。重试后用尽，终态 `error_code` 必然是 `PROVIDER_TIMEOUT`。该检查项永远红。
- **修复**：把 `spec/07` 的 `ERR-01` 期望值改为 `PROVIDER_TIMEOUT`；并**新增**一条 `ERR-05` 用 `fixtures/ark/model-not-open.json`（→ `PROVIDER_ERROR`，不可重试，`attempt=0`）覆盖另一分支。同步 T05/T09/T10 的表头归属（当前 `ERR-01` 在三条 ticket 里被互相推诿）。

### P0-4 `PR-04` 的归属与断言对象不匹配，`T06` 无法完成

- **位置**：`spec/07` §2.2（归属 `modules/M03`）↔ `modules/M03` §8 ↔ `modules/M05` §8
- **问题**：`PR-04` 判定"**全部 20 组** prompt 含 `不做任何美化` 与 `减龄`"——这是 `buildPrompt` 的输出，只有 M05 能产出。M03 §8 只能提供"锚点侧词表拦截兜底"，M05 §8 又说"归属 M03，本模块只提供【年龄保真】段"。归属 M03 的检查项，M03 无法执行。
- **修复**：`spec/07` §2.2 把 `PR-04` 归属改为 `modules/M05-年代场景配置与Prompt拼装.md`，断言落在 M05 的 `build.test.ts`（该文件已检查 `不做任何美化` / `减龄`）。M03 的锚点侧拦截另立 A 层断言（需先在 `spec/07` §2.9 注册新 ID，遵守 D1）。同时把 `T06` 表头的 `PR-04` 移到 `T08`。

### P0-5 `SEC-07` 一号两义，且两处写法都错

- **位置**：`spec/06` §2 第 5 行 ↔ `spec/07` §2.5
- **问题**：`spec/06` §2 说 `SEC-07` = 授权留痕（`audit_logs(anchor.confirm / consent.agree)`）；`spec/07` §2.5 说 `SEC-07` = `GET /api/auth/code` 返回 `devCode`。两者完全不同。且 `spec/07` 版本有两处硬错：① 端点是 **`POST`** 不是 `GET`（`spec/03` §3.1）；② `devCode` 的开关是 **`SMS_PROVIDER=console`**，不是 `PROVIDER=mock`（`spec/03` §3.1、`spec/06` §1.2）。**M08 §8 已经写出了正确版本并注明"`spec/07` 写作 `GET`，实际端点为 `POST`"——即文档作者已经发现这个冲突，却没有回改权威文档。**
- **修复**：把"授权留痕"另编号为 `SEC-09`（并在 `spec/06` §2、M04 §8 同步），`SEC-07` 保留 `devCode` 语义并改正为 `POST` + `SMS_PROVIDER`；随后 `check:docs` 会阻止这类一号两义。

### P0-6 生成入队的排他性检查放在"先 INSERT 后检查"的位置，字面实现会 100% 误拒

- **位置**：`modules/M06` §5.2 第 4 步
- **问题**："**单事务写入**——落库字段…`status = 'queued'`… **同一事务内再执行**：`countActiveByUser(userId) > 0` → `throw AppError('GENERATION_IN_PROGRESS')`"。按字面顺序，刚插入的行本身就是 `status='queued'`，`countActiveByUser` 必然 > 0，**任何第一次生成都会 409**。同处还以"SQLite **单进程**"为前提，而 `spec/04` §1 明确是"**两个进程**"；且 `db.transaction.exclusive()` 对应的是 `BEGIN EXCLUSIVE`，`BEGIN IMMEDIATE` 对应 `.immediate()`——文档把两者的语义写反了。
- **修复**：
  - 明确事务内的**执行顺序**并写进文档：`checkActive → 额度复查 → INSERT → audit`。
  - 删除"SQLite 单进程"的表述，改为"两进程共享一个 SQLite 文件"；改用 `db.transaction(...).immediate()`，并在 `getDb()` 设置 `PRAGMA busy_timeout`（见 P0-8）。
  - `spec/03` §1.5 的 `GENERATION_IN_PROGRESS` 描述同步补上"含本次请求之前已存在的非终态行"。

### P0-7 样片来源自相矛盾，且与"样片只能用真实留存图"红线冲突

- **位置**：`spec/08` §7、`spec/04` §2、`tickets/T14` §4.4 ↔ `spec/09` D12、`spec/era-scene-seed.json` 的 `note`
- **问题**：三处文档要求"从 `docs/output/` 拷 **6 张真实样片**…**禁止**用 mock 或 AI 生成图充当样片"。实测：`docs/output/` 只有 **3 张**与产品相关的图，且**全部是 2048×2048 的 PNG**——恰好等于 `spec/era-scene-seed.json` 里 4 个年代的 `defaultSize: "2048x2048"`，同目录其余 4 张是明确的模型能力测试图（`arkcli-01-laptop.png`、`seedream-lite-01-laptop.png`、柴犬等）。这三张几乎可以确定是**本项目自己用 Seedream 生成的输出**，不是"真实留存的老照片"。6 个 `samplePhoto` 槽位（`era-E2` / `era-E4` / `scene-S1` / `scene-S3` / `profile-E2-S1` / `profile-E4-S3`）无法由 3 张图如实填满，T14 照做即违反 D12。
- **影响面**：把 AI 生成图当作"该年代的真实示例"展示在卡片上，直接冲击 `spec/00` §4.2 的最高优先级约束（用户第一眼看到的就是一张 AI 图），并与上游 §8.2"年代卡片配该年代样片"的用意背道而驰。
- **修复**（推荐第 1 条）：
  1. 在 `spec/era-scene-seed.json` 里把无法对应真实留存图的槽位改为 `null`（文档已支持"暂无示例"的降级），T14 改为"按 seed 中非 null 的 `samplePhoto` 拷贝，允许 0–3 张"；T14 文案删去"6 张"。
  2. 若要保留 6 个槽位，则必须**先由人工确认**这 3 张图的真实来源，并在 `era-scene-seed.json` 增加 `samplePhotoSource` 字段如实标注（`real-archive` / `model-generated` + 生成参数）；标注为模型生成时不得用于年代/场景卡片主视区。
  3. 无论选哪条，都要在 `spec/08` §7 把"真实样片"的定义写死（什么算真实留存图、谁负责确认），并让 `check:docs` 校验 `samplePhoto` 非 null 的项在 `public/samples/` 下都有对应文件。

### P0-8 SQLite 双进程并发未设计，且迁移里的 `PRAGMA` 静默失效

- **位置**：`spec/02-schema.sql` 第 9–11 行、`spec/01` §5.1、`spec/04` §1 与 §4.3
- **问题**：
  - `PRAGMA journal_mode = WAL;` 写在迁移文件里，而 `spec/01` §5.1 规定 `migrate.ts` **每个迁移文件单事务执行**。SQLite 明确拒绝在事务内切换 journal_mode（`cannot change into wal mode from within a transaction`）——要么 `pnpm migrate` 直接抛错，要么（若驱动吞掉返回值）**WAL 静默未生效**。`PRAGMA foreign_keys = OFF` 在事务内同样是 no-op。
  - 全库没有任何 `busy_timeout` 设置，`spec/04` §4.3 只写了 `journal_mode` 与 `foreign_keys` 两条 PRAGMA；而架构是 **web 进程 + worker 进程同时写同一个 `data/app.db`**（web 写上传/软删/额度预扣，worker 写任务状态/照片/额度回滚）。
  - 相关文档还在用"单进程"论证并发安全（M06、M02 各一处）。
- **修复**：
  - 把所有 `PRAGMA` 从迁移 SQL 移到 `getDb()` 连接初始化（`db.pragma('journal_mode = WAL')` 等在**事务之外**执行），`spec/02-schema.sql` 只留 DDL。
  - `getDb()` 增加 `busy_timeout = 5000`（better-sqlite3 的 `timeout` 选项），并把 `SQLITE_BUSY` 加入 `RETRYABLE` 错误集合（`modules/M06` §5.5）。
  - 统一术语：全文用"两进程共享一个 SQLite 文件"，删掉"SQLite 单进程"的论证。
  - 新增一条 A 层断言：并发写入下不抛 `SQLITE_BUSY` 未处理异常；并在 `spec/04` §4.3 写明"跨表写必须在同一事务 + `BEGIN IMMEDIATE`"。

### P0-9 契约级冲突登记表（逐条给结论，不要留给 ticket）

| # | 冲突 | 建议结论 | 需同步的文件 |
|---|---|---|---|
| 1 | `DELETE` 幂等 200（`spec/03` §1.5）vs purge 后 404（M08 §5.3、T13 §4.3） | 契约补例外条款：资源已物理清理 → 404；未清理的重复删除 → 200 | `spec/03` §1.5、M08 §5.3、T13 §6 |
| 2 | `generation_results` 软删阶段保留（M08 §3.3）vs 立即物理删除（`spec/01` §2.3） | 保留 M08 语义（`GET /api/generations/:id` 按 `photos.deleted_at IS NULL` 过滤），**改 `spec/01` §2.3** | `spec/01` §2.3/§3.10、`spec/03` §3.5、M06 |
| 3 | 任务来源两张表（`spec/04` §4.6）vs 三张表（M06 §5.4） | 以三张表为准，改 `spec/04` §4.6；删掉 M09 §10 中对 M06 的错误引用 | `spec/04` §4.6、M09 §10 |
| 4 | 上传阶段审核：M01 无 reject 分支、`verdict` 默认 `pass`、错误表无 `CONTENT_REJECTED` vs M07 要求 422 | 采纳 M07：`POST /api/photos` 同步审核，`reject` → `422 CONTENT_REJECTED` + 不落盘；在 M01 §7 补错误码行、§5 补 reject 分支 | M01 §5/§7/§9、M07 §5.6、`spec/03` §3.2 |
| 5 | 结果图被审核拒 1 张：`partial`（M06 §5.3）还是任务 `failed`（M07 §5.6） | 采纳 M06 的 `n` 语义：被拒张不写 `generation_results`、不计入 `n`，任务终态由 `n` 决定；M07 改为"中止该张及后续张的转存" | M06 §5.3/§5.5、M07 §5.6、`spec/07` E2E-05 |
| 6 | `content_reviews` 写入条件：仅 reject（M06 §3）vs 每阶段都写（M07） | 采纳 M07（每阶段一行，`pass`/`review`/`reject` 都写），改 M06 §3 | M06 §3、M07 §5.6 |
| 7 | prompt 阶段审核的 `target_id=0` + `reason` 前缀 hack（M07 §8） | 把 `generations` 行的创建前移到 prompt 审核之前（`spec/03` §3.5），或用 `content_reviews` 新增 `meta` 承载阶段标记；**不得改写 `reason` 语义** | M07 §5.6/§8、`spec/03` §3.5 |
| 8 | `POST /api/generations/:id/retry` 的错误集（`spec/03` §3.5 只列 2 个，M06 §9 待定列出 5 个） | 在 `spec/03` §3.5 补全 `REALNAME_REQUIRED` / `ANCHOR_NOT_CONFIRMED` / `CONSENT_REQUIRED` | `spec/03` §3.5、M06 §9 |

---

## 4. P1 —— 打通第一条链路前（T01–T11 期间）必须修复

| # | 问题 | 位置 | 修复方案 |
|---|---|---|---|
| P1-1 | "82 项全绿"与"PRE/MARK 是 A 层、不是 `check:acceptance` 项"直接矛盾。§2 九个表实为 B 层 63 项 + 列在 B 层章节里的 A 层 19 项 = 82 | `spec/07` §3 `82 passed`、`tickets/README` §2 注、T20 §5 | 口径统一为"`check:acceptance` 断言 63 项，末行 `63 passed`；A 层 19 项由 `pnpm test` 断言"；把 `spec/07` §2.9 从"§2 B 层"里移出，单列 §3 或加显式小标题；数值由 `check:registry` 派生 |
| P1-2 | 首次情感安全提示无 owner、无触发机制；`pages/P03` 全文未提；且 `pages/P01` 禁止"已读"状态、`pages/P00` §6 禁止 `localStorage` | `spec/06` §9.2、`pages/P00` §5.1/§9.3、`pages/P03`、T17 | 在 `spec/06` §9.2 定死触发口径（建议"每会话一次"，状态放内存态）；`pages/P03` §6 补文案与位置；T17 目标与检查项补条目 |
| P1-3 | 检查项 ID 缺陷（详见附录 B）：`U14` 不存在；`API-06` 双 owner；`E2E-03`/`E2E-10`/`SEC-06` 无 owner；`ERR-01` owner 分散在 T05/T09/T10；`PR-04` 双认领 | `spec/06` §2、`spec/07`、`tickets/*` | 建 `check-registry.json` 并逐条改正归属（P0-4 已给 `PR-04` 结论） |
| P1-4 | `POST /api/results/:id/feedback` 与 `generation_results.user_feedback` 没有任何模块认领（`spec/03` §3.5、`spec/04` §2、`spec/02-schema.sql` 都有） | 无 | 归入 M06 §4（含归属校验、取值域、错误码）；T09 或 T17 表头补该端点 |
| P1-5 | M03 的"`features` **恰好含 12 个键**"与"**多余键丢弃，不落库**"自相矛盾；其测试又要求"多一个键 → `failed`" | M03 §5.4、M03 §8 | 二选一：`.strip()`（丢弃、不失败）或 `.strict()`（失败、不写）；同步修正测试用例 |
| P1-6 | HEIC：M01 §4.1 说"探测失败写 `NULL`、不阻断"，§7 错误表又说"heic 无 heif 解码能力导致探测失败 → `400 INVALID_FILE_TYPE`" | M01 §4.1/§7 | 拆成两类失败：容器可解析但读不到宽高 → `NULL` 继续；解码器打不开文件 → 400。并写出 `sharp` 错误码到两个分支的映射 |
| P1-7 | M02 / M03 依赖的 repository 函数未交付：M02 用 `findOriginalById` / `insertPreprocessed`，M01 §5 的签名清单里没有 | M02 §3/§5、M01 §5 | 在 M01 §5 补两个签名与软删条件，或让 M02 改用 `findActivePhotoForUser` + `insertPhoto` |
| P1-8 | M02 §4 的评分伪代码引用未定义符号（`stats()` / `st` / `L` / `hi` / `lo`），且 `AnalysisInput` 里没有承载它们的字段 | M02 §4 | 扩充契约：`{ gray1024, stats, histogram, width, height, faceBox }`，并指明由谁计算 |
| P1-9 | 防美化/AI 感的机器检查存在漏洞：`DB-03` 与 `PR-03` 的否定词正则为 `不要\|禁止\|不得出现\|no\s`，而种子数据里 4 段 `constraintPack` 用的是**"画面中不出现…"**（实测命中 4 处），两类正则都匹配不到 | `spec/07` §2.1/§2.2、`spec/era-scene-seed.json` | 正则补 `不出现\|不会出现\|无\s*任何`；或在 `spec/05` §3 的改写表里明确"不出现"属禁用形式并同步两处正则。**这是产品最核心约束的机器检查，优先级高** |
| P1-10 | prompt 长度有三套阈值：`spec/05` §9"建议 300–900，低于 200 不足，高于 1200 稀释" vs `spec/07` `PR-07` "[200, 1200]"；且 D5 禁止改数字阈值 | `spec/05` §9、`spec/07` §2.2 | 只保留一处定义（建议 `spec/07` `PR-07` 为唯一阈值），`spec/05` §9 改为引用 |
| P1-11 | `realismAnchor` / `agePreserveClause` / `confidenceHintThreshold` / `version` 是种子文件的**顶层字段，不属于任何表**：`pnpm seed` 只写 `eras/scenes/era_scene_profiles`，`spec/03` §3.4 要求下发 `realismAnchor` 与 `confidenceHintThreshold`，M05 §5 却读不到 | `spec/era-scene-seed.json`、M05 §5、T08、`spec/07` `DB-06` | 明确它们的落地：`src/server/prompt/versions.ts` 导出 `REALISM_ANCHOR` / `AGE_PRESERVE_CLAUSE` / `CONFIDENCE_HINT_THRESHOLD`，并加 A 层断言"与 `era-scene-seed.json` 顶层字段逐字符一致"。同时解决 M05 的三重事实源（`spec/05` §2 / 种子 / `template.ts`）——建议**代码为唯一事实源，`spec/05` 只写结构** |
| P1-12 | 前端三处互斥："`/` 是否需登录"（`pages/P00` §5.1 ③ 与 P01 §4.1 相反）、"轮询出错是否继续"（`pages/P00` §7 ⑤ 与 P01 §5 相反）、"worker 未存活提示落点"（`pages/P00` §4.2"只落上传页" vs P03 §5"结果页硬要求"） | `pages/P00`/`P01`/`P03` | 各取一个结论并回改另两处；`WorkerNotice` 落点建议"上传页 + 结果/历史页内联，不进全局 `ErrorNotice`"，并把 `WorkerNotice` / `AsyncStatus` / `ConfirmDialog` 补进 `pages/P00` §2 的共用组件清单（P03 已引用但 P00 未列） |
| P1-13 | 交付物数量与清单已过期：`spec/04` §2 说 11 个 repository，T18 又新建第 12 个（`promptReverseJobs.ts`）；T18 新建第 9 个 fixture 而 `spec/08` §5.1 冻结了 8 个；T05 与 T11 都声明新建 `era-check.json` / `safety-review.json`；`spec/04` §2 的 `reverseService` 与 T18 的 `promptReverseService` 命名不一致 | `spec/04` §2、`spec/08` §5.1、T05/T11/T18 | 以目录为准 + `check:docs` 断言；统一命名（建议 `reverseService.ts` 与 `jobs/handlers/reversePrompt.ts`，修 T18） |
| P1-14 | 历史页不覆盖"已上传但未确认锚点"的照片，导致这类照片**既看不见也删不掉**，违反上游 F5"可随时彻底删除**任何**照片" | `pages/P03` §7/§8、`spec/03` §3.6 | 增加"未完成的照片"区块或 `/me/photos` 路由并复用同一删除弹窗；`spec/03` §3.6 补该查询（当前只返回 `status='succeeded'` 的锚点链路） |
| P1-15 | F4 被放在 `/choose/[anchorId]` 的折叠面板里（`pages/P02` §6），而该页的守卫要求锚点已确认——即"降低选择门槛"的功能必须先走完上传→提取→确认→勾选授权全链路，与其定位矛盾 | `pages/P02` §2/§6 | 把 F4 入口移到 `/upload`（照片已存在即可用），或独立成路由；若接受当前约束，需在 `pages/P02` §9 记为"已接受的偏差" |
| P1-16 | T16（前端）依赖 T18 交付的后端端点，但依赖图与 T16 的依赖列表都没有连边；`ReversePromptPanel` 的归属在三处文档里有两份结论 | `tickets/README` §1、T16 §1/§3、T18 §2、`pages/P02` §10 | 补边 `T18 → T16`；`ReversePromptPanel` 统一定为 T16 交付、T18 只交付后端（改 `pages/P02` §10） |
| P1-17 | M01–M09 的"新建文件"在多个 ticket 里重复声明（`moderation.ts` T03+T11、`audit.ts` T03+T07、`versions.ts` T06+T08、`repositories/audit.ts` T07+T09、`generationService.ts` T07+T08+T09、`shared/types.ts` T01 之后仍被标"新建"） | 各 ticket §3 | 按时间线唯一化：首个 ticket 标"新建"，其余标"修改"；该规则交给 `check:docs` 校验 |
| P1-18 | M01/M04/M09 的三处接口签名与 spec 不一致：`delete()` 的"不存在返回 false"与"`ENOENT` → `NOT_FOUND`"冲突；`?w=` 的 `[16,2048]` 取值域未进 `spec/03`；M09 §5.1 的端点写成 `{ARK_BASE_URL}/api/v3/chat/completions`（双前缀）；M09 §5 把模型名硬编码进 SQL 而文中说取自 `ARK_VISION_MODEL` | M01 §4/§5/§6、M09 §5 | 逐条回改：签名注明每个方法的错误映射；`?w=` 范围写入 `spec/03` §3.2 或改为 clamp；统一为 `{ARK_BASE_URL}/chat/completions`；SQL 参数化模型名 |

---

## 5. P2 —— 打磨与一致性（可并行、不阻断）

- **命名与规范**：`pages/P03` §2 用 PascalCase 组件名（`ResultGrid.tsx`），违反 `pages/P00` §2 的 kebab-case 约定；`pnpm check` / `pnpm typecheck` 两个名字混用（`spec/07` §5.1 与 `spec/09` §7 不一致）；心跳文件路径存在三套写法（`.<DATA_DIR>/worker-heartbeat` / `./data/worker-heartbeat`），`.<` 前缀无意义，建议统一为 `<DATA_DIR>/worker-heartbeat`。
- **可读性缺陷**：`reject` 一词同时用于年代复核（"不阻断交付"，M07 §2）与内容审核（"终止任务"，M07 §5.6），语义相反——建议改名 `eraCheckVerdict` / `moderationVerdict`。
- **下载**：文件名硬编码 `.png`，而 `params.outputFormat` 可为 `jpeg`——应从 `params` 派生扩展名。
- **索引**：M01 §6 称去重查询"走 `idx_photos_sha256` + `idx_photos_user_created`"；实际 `idx_photos_sha256` 只索引 `sha256`，单次查询只用得上一个索引。建议加 `002-*.sql` 建 `(user_id, sha256) WHERE deleted_at IS NULL`，或改正描述。
- **URL 稳定性**：`pages/P02` §2 用 `?scene=1`（`scenes.id` 自增）做可分享 URL，而 `scenes.id` 由 `pnpm seed` 的插入顺序决定；建议在种子里固定 `id`，或 URL 改用 `sceneCode`。
- **错误页面与开放重定向**：多处 `notFound()` / `redirect('/login?next=…')` 但没有 `not-found.tsx` / `error.tsx` 规范，`next` 参数也无同源校验——建议在 `pages/P00` 补页面与 `next` 的相对路径校验规则。
- **上传即丢弃**：刷新页面会丢掉已落库的 `photos` 行 id，且这些照片无处可见（见 P1-14）——建议定义"中断上传的恢复/清理"规则。
- **`filePicker` 逻辑不可实现**：`pages/P01` §4.2 说"超过 5 张按 `readability` 降序取前 5"，而 `readability` 来自预处理（上传之后）——改为"取前 5 张"。
- **合规文案**：`spec/07` §4 在交付物 `report.md` 的模板里要求写"包含**逝者**家属本人"，而 `spec/06` §9.1 把"逝者"列为出现即返工的禁用词（`CMP-02` 只扫 `app/`/`components/`/`src/`，扫不到 `docs/`）——改为"照片中人物的家属本人"，并考虑把 `CMP-02` 的扫描范围扩到交付物。
- **未覆盖的合规缺口**（建议至少在 `spec/06` §1.2 记为明确不做）：数据留存期无定义（`PURGE_GRACE_MINUTES=10` 是删除延迟，不是留存期）；"照片加密存储、传输 HTTPS"无落点；账户级"一键清空全部数据"被排除；未成年人场景（照片中或用户本人）无任何条款。
- **`?w=` 与图片性能**：`spec/03` §4 只声明 `url: string`，而 `pages/P00` §5.1 依赖"`url` 由服务端给且带 `?w=`"——把该规则写进契约，否则 `/upload` 与 `/result` 会渲染 20MB 原图与 2048² 生成图。

---

## 6. 最佳实践落地清单（可直接执行）

> 按"先立规矩，再改内容"的顺序，前 6 项是文档体系层面的改造，一次性投入可长期防止同类问题复发。

### 6.1 新增 `docs/prd/spec/check-registry.json` + `pnpm check:docs`

规则（每条对应本报告的一类缺陷）：

| 规则 | 拦截的问题 |
|---|---|
| ID 全局唯一 | `SEC-07` 一号两义 |
| 每个 ID 恰有 1 个 owner | `API-06` / `PR-04` 双 owner |
| 每个 ID 至少被 1 个 ticket 认领 | `E2E-03` / `E2E-10` / `SEC-06` 无 owner |
| ticket 声明的 ID 必须存在于注册表 | `U14` |
| `新建` 文件全仓库唯一 | P1-17 六处重复声明 |
| 声明的文件/目录/fixture 必须实际存在 | P1-13 |
| 条目计数 == 脚本打印的通过数 | P1-1 的 82/63 |

### 6.2 契约单一事实源 + "引用不复制"

- 规则入 `spec/09`：跨模块契约只允许在原文档出现一次。
- 建议的事实源划分：错误码 → `spec/03` §5；阈值 → `spec/07` §2；prompt 正文 → `src/server/prompt/template.ts`（`spec/05` 只写结构）；年代/场景包 → `spec/era-scene-seed.json`；表与列 → `spec/01` + `spec/02-schema.sql`；worker 契约 → `spec/04` §4.6。

### 6.3 新增 `docs/prd/spec/10-上游能力台账.md`

一行一能力 × 实测状态 × 证据 × 影响 × 降级方案；闸门规则 = "未验证能力不得进 schema / 检查项 / 对外承诺"。

### 6.4 新增 `docs/prd/spec/11-需求追溯矩阵.md`

上游条款 → 处置 → 理由 → 落点 → 检查项 → 残余风险；`spec/00` §8 只留 5 条最重要的。

### 6.5 契约冻结与变更流程

`spec/00` 增"契约冻结清单"（端点 / 状态机 / 表 / 错误码，全部标注"已冻结"）；新增 `spec/CHANGELOG.md`；`spec/09` §5.4 补一句"契约级分歧不得记为 ticket 待定"。

### 6.6 数据层修正（一次性）

1. PRAGMA 移出迁移，进 `getDb()`；加 `busy_timeout`。
2. `002-*.sql`：补 `prompt_reverse_jobs` 的三列（P0-2）；加 `photos(user_id, sha256)` 部分索引。
3. 若 `seed` 未被支持，去掉 `generation_results.seed`。
4. 明确 `generation_results` 的保留策略（P0-9 第 2 条）并在 `runPurge` 里按 `generation_id` 兜底清理孤儿行。

### 6.7 前端负路径与情感安全

新增 `docs/prd/pages/P04-失败与情绪安全路径.md`（S6），覆盖：提取失败、质量不可用、生成失败、结果不像他、超时、额度用尽、worker 未启动、未实名、未确认锚点。

### 6.8 补充"前置桩"ticket 的显式出口

`tickets/README` §1 说 M1/M2 用种子 `DEV_USER` 跑通 T03–T11，但 `requireUser()` / 会话读写全部在 T12（M3）交付——M1/M2 的受保护端点没有鉴权实现。建议在 `T02` 增加一小节"`requireUser()` 桩（读 `DEV_USER`，不查 cookie）"，并在 T12 明确"替换为真实会话"的出口条件与回归项（含 `API-03`）。同类问题还有：`readQuota()` 归 T12 但 T09 需要它（`SEC-04`）、T14 的 `SiteHeader` 消费 `/api/me`（T12 交付）——建议统一在依赖图里补边，或把额度读取下沉到 T09。

---

## 7. 整改路线图

> **行动方案已执行完毕，见 `docs/output/PRD-整改方案.md`**（零前置：8 个挂点已全部落地，检查项口径统一为 B 层 65 + A 层 19，孤儿/双属/幽灵检查项均为 0；41 条延后项已逐条写入对应 ticket 的 `## Comments`）。
> 本节保留两条不可省略的结论：

1. **P0 的 9 条必须全部清零再开工**——其中 4 条是"定义即错的检查项"（`ERR-01`、`SEC-07`、`PR-04`、`U14`），它们会把 AI 工人引向"为了让检查变绿而改期望值"，而 `spec/09` D6 恰好禁止这件事。修好这 4 条，整套检查项体系的信用才立得住。
2. **P1 的 18 条与 P2 不阻塞开工**，逐条下推给拥有该文件的 ticket 的 `## Comments`（`spec/09` §5.1 已规定该通道）；只有 `pages/P04` 负路径必须在 T15–T17 之前完成。


---

## 附录 A · 火山引擎断言核验结果

证据源：`docs/火山引擎接口文档.md`、`ark-examples/**/{curl.sh,python.py}`、`.scratch/api_image_response.json`、`.scratch/api_chat_response.json`、`.scratch/seedream_era_scene.js`。

| # | PRD 断言 | 判定 | 证据 |
|---|---|---|---|
| 1 | 生图模型 `doubao-seedream-5-0-lite-260128` | 间接验证 | `docs/火山引擎接口文档.md` §1.1；`.scratch/seedream_era_scene.js` 的 `const MODEL`。**无原始请求体留存证明该字符串被 API 接受** |
| 2 | 多模态模型 `doubao-seed-2-1-turbo-260628` | 已验证 | `.scratch/api_chat_response.json` 返回体 `"model":"doubao-seed-2-1-turbo-260628"` |
| 3 | Endpoint ID（`ep-…`）≠ Model ID | 已验证 | `ark-examples/ep-20260917134606-9qt4p/…/curl.sh` 的 `"model": "ep-20260917134606-9qt4p"`；接口文档 §"requires an endpoint id" |
| 4 | `POST /api/v3/images/generations`、`POST /api/v3/chat/completions` | 已验证 | 接口文档 §1.1 / §3.1；`ark-examples/**/curl.sh` |
| 5 | Responses API 未验证成功、禁用 | 已验证 | 接口文档 §2.4："三种 payload 形态均返回 `InternalServiceError`"、"该通道本次**未能直连复现**"；§0 亦明确"两者不能混为一谈" |
| 6 | `size` 下限 总像素 ≥ 3,686,400 | 已验证 | 接口文档留存真实错误：`image size must be at least 3686400 pixels` |
| 7 | `size` 上限 16,777,216、宽高比 ∈ [1/16,16] | **无证据** | 只出现在接口文档的结论行，无实测错误或返回佐证 |
| 8 | `image` ≤14 张 / ≤30MB / ≤6000×6000 | **无证据** | 多图示例只用了 **2 张**；且端到端实测③是**纯文生图，未带参考图** |
| 9 | `negative_prompt` / `guidance_scale` lite 不支持 | **无证据** | 文档断言；`ark-examples` 与 `.scratch` 中从未出现这两个参数，也无对应报错 |
| 10 | `optimize_prompt_options.mode` 仅 `standard` | 间接验证 | 接口文档 §1.2 标注"⚠️ `fast` 仅 5.0 完整版支持"；脚本实际使用 `standard` |
| 11 | 返回 `model` 规范化为 `doubao-seedream-5-0-260128` | 已验证 | `.scratch/api_image_response.json` 的 `"model"` 字段 |
| 12 | `data[].url` 签名链 86400s | 已验证 | 该 URL 含 `X-Tos-Expires=86400` 与 `X-Tos-Signature` |
| 13 | `output_format` lite 可设 png/jpeg | 部分验证 | `png` 实测可用；"仅 lite 可设、5.0 完整版固定 jpeg"为推断（完整版从未被调用） |
| 14 | **`seed` 参数被接受并返回 → "可复现"** | **无证据（最高风险）** | 接口文档 §1.2 的完整参数表**不含 `seed`**；返回样本 `data[0]` 只有 `{url,size}`；调用脚本**从不设置也不读取 seed** |
| 15 | `watermark` 是真实参数 | 已验证 | `ark-examples/**/curl.sh` 的 `"watermark": true`；接口文档 §1.2 |
| 16 | 请求 `2048x2048` → 返回即 2048×2048 | **与证据冲突** | 接口文档 §1.5 实测"请求 `2048x2048`，实际返回 `"size":"1920x1920"`"——`generation_results.width/height` 应取**转存后图片的实际像素**，不能假设等于请求值。另：`README.md` §4.1 把 size 下限写作"总像素 ≥ **3,686,400**（如 `2048x2048`）"，而 2048² = 4,194,304 ≠ 3,686,400；接口文档 §1.3 明确"1920×1920 为下限边界值，2048×2048 为推荐值"——两处混用了"下限示例"与"推荐值" |

**最高风险的三条未验证假设**：① `seed` 被接受且返回（决定"可复现"承诺与 `generation_results.seed` 列）；② 多图参考的身份一致性真实可用且上限成立（决定产品核心卖点，且现有实测**没有一次带过参考图**）；③ `negative_prompt` 确实不支持（决定 §3 全正面化改写是否是唯一出路）。

---

## 附录 B · 检查项 ID 缺陷清单

| 类型 | ID | 位置 | 问题 |
|---|---|---|---|
| 不存在 | `U14` | `spec/06` §2 引用（并称在 M01 §8，实际 M01 §8 是"配置与环境变量"） | 该 ID 在 `spec/07` 中不存在 |
| 一号两义 | `SEC-07` | `spec/06` §2（授权留痕）vs `spec/07` §2.5（`devCode`） | 同一 ID 两种语义 |
| 定义即错 | `SEC-07` | `spec/07` §2.5 | 写成 `GET /api/auth/code` + `PROVIDER=mock`；正确为 `POST` + `SMS_PROVIDER=console`（M08 §8 已知该错误但未回改） |
| 双 owner | `API-06` | `spec/07` §2.3 归 M08；M05 §8 与 M08 §8 各自认领 | 应归 M05（端点是 M05 的） |
| 双 owner | `PR-04` | `spec/07` §2.2 归 M03；T06 与 T08 表头均认领 | 断言对象只有 M05 能产出 |
| 无 owner | `E2E-03` | `spec/07` §2.4 | 无 ticket 表头声明 |
| 无 owner | `E2E-10` | `spec/07` §2.4 | 无 ticket 表头声明 |
| 无 owner | `SEC-06` | `spec/07` §2.5 归 M03 | 无 ticket 表头声明 |
| owner 分散 | `ERR-01` | T05 表头声明，T05 正文推给 T09，T09 正文推给 T10 | 三处互相推诿 |
| 不可能通过 | `ERR-01` | `spec/07` §2.7 | 期望 `PROVIDER_ERROR`，实现必然 `PROVIDER_TIMEOUT` |
| 计数口径错 | 全部 | `spec/07` §3、T20、`tickets/README` | "82 项全绿"含 19 项 A 层，`check:acceptance` 实为 63 项 |

---

## 附录 C · 上游需求追溯缺口（`spec/00` §8 与 `README` §0 未记录）

| # | 上游要求 | 现在的处置 | 是否记录 | 建议 |
|---|---|---|---|---|
| 1 | §4 F2④ / F2 验收："年代穿帮**不得出现**" | 降级为"标注 + 不阻断下载 + 可下载"（`pages/P03` §6） | ❌ | 记入 RTM，并给出补偿（如穿帮图的额度返还或强制重生成按钮） |
| 2 | §4 F6 + §12："情感安全提示（首次进入时）" | 保留文案，**无触发机制、无 owner** | 部分 | 见 P1-2 |
| 3 | §12："提供侵权投诉与下架通道" | 删除（`spec/06` §10"不存在"） | ❌ | 记入 RTM；至少补静态联系方式 |
| 4 | §12："异常调用风控" | 删除（`spec/06` §8"不做行为分析/黑名单/频率熔断"） | ❌ | 记入 RTM 并写明本地范围的残余风险 |
| 5 | §10 性能："单次生成 ≤ 60s" | 实际 `JOB_TIMEOUT_SECONDS=120`、轮询超时 90s/180s | ❌ | 记入 RTM，并在 `spec/07` §6 补 `[real]` 的手工时延记录项 |
| 6 | §7.4 + §12："盲测作为上线闸门（不通过禁止上线）" | 降级为"只交付材料与评分表，不下达判定" | ❌ | 记入 RTM，并明确 go/no-go 的 owner |
| 7 | §8.3："可见标识开关（默认关闭但必须提供）" | 不做（`spec/06` §4、`spec/00` §6.2 已记，但不在 §8 差异表） | 部分 | 补进 `spec/00` §8 |
| 8 | §10 隐私："照片加密存储、传输 HTTPS" | 无落点 | ❌ | 加入 `spec/06` 的"生产必须补"对照表 |
| 9 | §10 隐私："一键彻底删除" | 变为两级删除（按链路/按锚点），账户级清空明确不做 | ❌ | 记入 RTM |
| 10 | §10 兼容："移动端优先" | 收窄为"只保证 375px 与 1280px 两个宽度可用"，且无逐页移动端布局规则 | ❌ | 记入 RTM，并给 `pages/P03` 的网格/链路/灯箱补 375px 规则 |
| 11 | §6.2 模型用途③"口语化需求 → 映射到 E/S 代号" | 随"自定义场景"一并删除 | 隐含 | 在 `spec/00` §6.2 显式列出 |
| 12 | §6.2 模型用途⑤"安全判定与情感化文案生成" | 未实现（文案为手写固定） | ❌ | 在 `spec/00` §6.2 显式列为不做 |

---

## 附录 D · 评审方法与覆盖范围

- **全文通读**：`docs/prd/` 全部 46 个文件；`docs/raw/AIGC_PRD.md`；`docs/火山引擎接口文档.md`；`ark-examples/**`；`.scratch/` 下的两份真实报文与调用脚本。
- **交叉核对**：以 `spec/01`（表/列）× `spec/02-schema.sql` × `spec/03`（端点/错误码）× `spec/07`（检查项 ID）为四条主轴，逐模块/逐页/逐 ticket 比对。
- **技术验证**（实跑）：
  - `docs/output/*.png` 的 PNG IHDR 尺寸解析 → 7 张全部 2048×2048（附录 A / P0-7 的依据）。
  - `spec/era-scene-seed.json` 计数：4 年代 / 5 场景 / 20 组合；`confidence < 0.6` 恰 5 组；`不出现` 出现 4 次（P1-9 的依据）。
  - `spec/02-schema.sql` 逐表核对：15 张业务表 + `schema_migrations` = 16，与 `DB-01` 一致；确认 `prompt_reverse_jobs` 缺 `started_at`/`attempt`/`error_code`。
- **覆盖说明**：本报告未复核 `docs/老照片/` 两张输入图的具体画质与锚点提取可行性（属实测范畴），也未对 `spec/era-scene-seed.json` 的 20 组 prompt 文本做逐句文风评审。
