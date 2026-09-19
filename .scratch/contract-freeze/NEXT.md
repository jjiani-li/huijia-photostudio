# NEXT · 接着干

> 会话交接说明。仓库：`D:\桌面\wt-20260915\day3`（Windows；Bash 工具走 Git Bash，用 Unix 语法）。
> **pnpm 不在 PATH 上**（`corepack enable` 在这个环境需要管理员权限），一律用 `corepack pnpm <script>`。

## 现在在哪

- **产品线（`docs/prd/tickets/`）：`T01`–`T20` 已全部交付**，工作树干净（除下方「无关改动」）。
- **`T20`（最终验收收口）交付内容**：
  - `scripts/smoke.ts`（新建，`pnpm smoke`：进程内直调 route handler 走完 `E2E-01` 全链路，先探 `GET /api/health`，`db.ok=false` / `worker.alive=false` 直接失败并提示；`--real` 手动真实调用；自带清理与额度回滚）、`scripts/blind.ts`（新建，`pnpm check:blind --out <目录>`：`sheet.html` / `answer-key.json` / `score-template.csv` / `report.md` 四件材料）。
  - `package.json` 接 `smoke` / `check:blind` 两条脚本。
  - `scripts/acceptance.ts` 补齐 B 层最后 9 项：`API-01`、`API-02`、`API-04`、`E2E-02`、`E2E-03`、`E2E-10`、`SEC-06`、`ERR-03`、`CMP-02`——末行 **67 passed, 0 failed, 0 skipped**。
  - 文档收敛：`spec/08-本地开发指南.md` §3 / §9（新增 `pnpm smoke` / `pnpm check:blind` 与 `blind-runs/` 路径）、`spec/06-合规与风控.md` §12.2 与 `spec/07-验收标准.md` §2.8 的 `CMP-02` 扫描面澄清（用户可见文案；测试文件与 prompt 正文资产除外）。
- **没有下一张**：20 条工单全部交付。要继续干活得由人工指定新方向（例如 `.scratch/upstream-capability-verification/` 的上游能力探针）。

## 工具现状（改动它们要同步 `docs/prd/spec/08-本地开发指南.md` §3.3 与脚本头部注释）

- `docs/prd/spec/check-registry.json`：89 条检查项（B 67 / A 22）。
- `scripts/check-docs.mjs`：17 条静态断言；`--root` 指夹具树、`--write-index` 按工单表头重写 `tickets/README.md` 的检查项列。
- `scripts/check-docs.test.mjs`：50 个夹具用例（新增断言必须配用例）。
- `scripts/acceptance.ts`：B 层执行器，现输出 **67 passed, 0 failed, 0 skipped**（67 项全部落地，无「未实现」）。
- `scripts/smoke.ts`：`pnpm smoke` 的端到端冒烟（默认 mock；需 `pnpm migrate && pnpm seed` 与 `pnpm worker`）。
- `scripts/blind.ts`：`pnpm check:blind --out ./blind-runs/<日期>` 的 C 层四件材料（空样本集照常产出并退 0）。
- 产品骨架：Next 15 + TS strict + vitest（**70 文件 / 626 用例**）+ eslint/tsconfig/`package.json` + Tailwind（`tailwind.config.ts` 为 Token 唯一落点）。

## 一条 ticket 的做法（T01–T20 都按这个走）

1. 读 `docs/prd/tickets/TNN-*.md` 的「必读文档 + 要交付的文件 + 实现要点 + 完成判定」与该 ticket 的 `modules/MNN`。
2. **收敛文档**（跨多个文件时可分包给子代理并行做，然后统一验证）；工单 §3 的「新建/修改」栏若与现状不符，一并改对。
3. 清单要求断言的，就加/改闸门断言 + 夹具用例；改完文档树必须全绿。
4. 跑齐：`corepack pnpm check:docs`、`corepack pnpm test:docs`、`corepack pnpm test`、`corepack pnpm check`（外加该 ticket 完成判定里的 `corepack pnpm migrate && corepack pnpm seed && corepack pnpm check:acceptance`，T20 还要 `corepack pnpm smoke`）。**改了 `docs/prd/**` 一定要重跑 `check:docs`。**
5. 提交（提交信息写清「按 ticket 的清单做了什么、哪些是前几轮已收口只是核对、评审追加项」）。
6. 用 `/code-review` 的两轴（Standards / Spec）子代理评审本次 diff（基线取上一个提交），按意见收口后再提交一次。
7. 在 ticket 的 `## Comments` 写交付记录、偏离说明与未落地项；**停下汇报**——一章一停。

## 冷启动指令（新会话直接发给我）

全部 20 条工单已交付，**没有默认的下一张**。若要继续，先人工指定方向，例如：

```
在 D:\桌面\wt-20260915\day3 继续。全部工单已交付；先读 .scratch/contract-freeze/NEXT.md 与
docs/prd/spec/09-施工纪律.md，然后按我指定的方向开工（不要自行取票）。
```

## 已知遗留 / 注意事项

- `docs/提示词.md` 在工作树里显示为已修改：这是**先前的无关改动**（提示词原始素材），历次交付都没动它、也没提交，忽略即可。
- **`CMP-02` 的扫描面**（`spec/06-合规与风控.md` §12.2、`spec/07-验收标准.md` §2.8）：口径是「用户可见文案」；`*.test.ts(x)`（按约定把禁用词当负例枚举）与 prompt 正文资产 `src/server/prompt/`（含「不是修复照片」，给模型的指令）不参与扫描。这个澄清是按 `spec/09-施工纪律.md` §5 第 5 条回改 `spec/` 的，口径记在 `tickets/T20` 的 `## Comments`。
- **`API-02` 的实现形态**：共享 schema 只覆盖 `spec/03-接口契约.md` §4 列出的形状；`{ ok: true }` / `{ ok, cascaded }` / `POST /api/auth/code` 的 `{ sent, expiresInSec, devCode? }` / 二进制读图按文档顶层键集与响应头断言（不新增 schema）。口径记在 `tickets/T20` 的 `## Comments`。
- **`E2E-01` / `E2E-02` / `E2E-10` 共用 `driveSampleChain()`**：跑一遍 `pnpm check:acceptance` 会驱动 3 次真实链路（每次约 10s）。
- `pnpm smoke` 需要 `pnpm worker` 在另一终端存活（探活失败即报错提示）；`pnpm check:acceptance` 不需要。
- **`pnpm check:acceptance` 与 `pnpm worker` 不能同时存活**：`scripts/acceptance.ts` 是进程内直调端点与 handler 的执行器，`SEC-05` 依赖自己刚建的 `queued` 生成行保持非终态；worker 一存活就会把它领走并快速落终态（夹具锚点用不落盘的 `sharedPreprocessedPhoto()`），于是 `SEC-05` 报 `NO_THROW`。实测无 worker 时 **67 passed / 0 failed**，worker 存活时 66 passed / 1 failed（仅 `SEC-05`）。跑法：`check:acceptance` 在没起 worker 的终端跑，`smoke` 在 worker 存活时跑。口径记在 `tickets/T20` 的 `## Comments`。
- `docs/提示词.md`、`ERR-01`/`ERR-05`（随 T10）、`E2E-01`（随 T15）、`E2E-02`（随 T20）、`E2E-03`（随 T20）、`E2E-10`（随 T20）均已落地；`CMP-06` 的断言落点在 `scripts/acceptance.ts`（静态扫描）。
- `API-09`/`RN-01`–`RN-04` 随 T19 补齐；`ID_VERIFY_PROVIDER=real` 抛 `INTERNAL`（生产留空位），实名证件号规则取 GB 11643 的 18 位 + ISO 7064 MOD 11-2 校验位。
- `pnpm build` 全绿（27 路由），`src/server/ark/fixtures.ts` 用 `path.dirname(fileURLToPath(import.meta.url))` 的 webpack 安全写法。
- 若干刻意延后项见各 ticket 的 `## Comments`（如 `modules/M03` 锚点提取不自动重试是设计；T18 的 `CONTENT_REJECTED` 在上传阶段即软删被拒照片而不可达）。
