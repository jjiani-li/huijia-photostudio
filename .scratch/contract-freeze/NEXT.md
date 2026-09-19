# NEXT · 接着干

> 会话交接说明。仓库：`D:\桌面\wt-20260915\day3`（Windows；Bash 工具走 Git Bash，用 Unix 语法）。
> **pnpm 不在 PATH 上**（`corepack enable` 在这个环境需要管理员权限），一律用 `corepack pnpm <script>`。

## 现在在哪

- **产品线**（`docs/prd/tickets/`）：**T01–T14 已全部交付并两轴收口**，工作树干净（除下方「无关改动」），全部已提交：
  - T01 脚手架 · T02 数据层 · T03 照片资产 · T04 预处理/评分 · T05 ArkProvider · T06 身份锚点 · T07 身份确认/授权 · T08 年代场景配置与 Prompt 拼装 · T09 生成编排 · T10 生图调用与结果转存 · T11 生成后复核与内容审核 · T12 账号/会话/额度 · T13 历史/再生成/彻底删除 · T14 前端基础（Token/外壳/通用组件/`/login`）。
- **开工顺序（已确认，固定）**：**`T18` → `T16` → `T17` → `T19` → `T15` → `T20`**（`T15` 与 `T19` 可互换；`T20` 是最终验收收口）。
  - 依据 `tickets/README.md` §1 依赖图：`T18`（依赖 `T05`、`T06`）/`T16`（依赖 `T08`、`T14`）/`T19`（依赖 `T12`）现在即可开工；`T15` 由 `T18` 解锁；`T17` 由 `T16` 解锁（`T13` 已就位）；`T20` 依赖全部。
- **下一张是 `T18`**：`docs/prd/tickets/T18-图片反推提示词.md`。
- **工作规则不变**：收敛文档 → 按清单加/改闸门断言与夹具用例 → 跑齐 `corepack pnpm check:docs / test:docs / test / check`（外加该 ticket 的 `migrate && seed && check:acceptance`）→ 提交 → `/code-review` 两轴评审并收口 → 写 `## Comments`。**每完成一张 ticket 就暂停汇报，等人工明确同意再开下一张。**
- **契约单点化系列**（`.scratch/contract-freeze/`）：01–11 已全部交付并置 `ready-for-human`，没有下一张。

## 工具现状（改动它们要同步 `docs/prd/spec/08-本地开发指南.md` §3.3 与脚本头部注释）

- `docs/prd/spec/check-registry.json`：89 条检查项（B 67 / A 22）。
- `scripts/check-docs.mjs`：17 条静态断言；`--root` 指夹具树、`--write-index` 按工单表头重写 `tickets/README.md` 的检查项列。
- `scripts/check-docs.test.mjs`：50 个夹具用例（新增断言必须配用例）。
- `scripts/acceptance.ts`：B 层执行器，现 **47 passed**（进程内直连 domain/端点，自带清理）。
- 产品骨架：Next 15 + TS strict + vitest（**338 用例**）+ eslint/tsconfig/`package.json` + Tailwind（`tailwind.config.ts` 为 Token 唯一落点）。

## 一条 ticket 的做法（T01–T14 都按这个走）

1. 读 `docs/prd/tickets/TNN-*.md` 的「必读文档 + 要交付的文件 + 实现要点 + 完成判定」与该 ticket 的 `modules/MNN`。
2. **收敛文档**（跨多个文件时可把「同一类、互不重叠的文件」分包给子代理并行做，然后统一验证）；工单 §3 的「新建/修改」栏若与现状（T02 已建的骨架文件）不符，一并改对。
3. 清单要求断言的，就加/改闸门断言 + 夹具用例；改完文档树必须全绿。
4. 跑齐：`corepack pnpm check:docs`、`corepack pnpm test:docs`、`corepack pnpm test`、`corepack pnpm check`（外加该 ticket 完成判定里的 `corepack pnpm migrate && corepack pnpm seed && corepack pnpm check:acceptance`）。**改了 `docs/prd/**` 一定要重跑 `check:docs`。**
5. 提交（提交信息写清「按 ticket 的清单做了什么、哪些是前几轮已收口只是核对、评审追加项」）。
6. 用 `/code-review` 的两轴（Standards / Spec）子代理评审本次 diff（基线取上一个提交），按意见收口后再提交一次。
7. 在 ticket 的 `## Comments` 写交付记录、偏离说明与未落地项；**停下汇报，等人工确认再进下一章**——一章一停。

## 冷启动指令（新会话直接发给我）

```
在 D:\桌面\wt-20260915\day3 继续产品线。先读 .scratch/contract-freeze/NEXT.md 与
docs/prd/tickets/T18-图片反推提示词.md，按 docs/prd/spec/09-施工纪律.md 的施工纪律与 T01–T14 的既有做法
实现 T18：收敛文档、按清单加/改闸门断言与夹具用例，完整跑
corepack pnpm check:docs / test:docs / test / check 与 check:acceptance，提交，再跑 /code-review
两轴评审并收口。**一章一停**：交付后停下汇报，等我回复同意再进下一章。
```

（开工顺序固定为 `T18 → T16 → T17 → T19 → T15 → T20`；把上面的 `T18` 换成当前这一张即可。）

## 已知遗留 / 注意事项（不必现在处理）

- `docs/提示词.md` 在工作树里显示为已修改：这是**先前的无关改动**（提示词原始素材），历次交付都没动它、也没提交，忽略即可。
- `ERR-01` / `ERR-05` 已随 T10 补齐；`E2E-03` 随 T09 补齐。
- `DEL-01`–`DEL-04` / `CMP-05` 随 T13 补齐；`/api/history` 的 `url` 带 `?w=400`、`deletePhoto` 对「已物理清理的行」按 `spec/03` §1.5 返 `200`（幂等）是 `modules/M08` §9 已收口的口径。
- **`pnpm build` 已随 `tickets/T05` 的 fixtures 路径修复转绿**（T14 会话发现、经人工同意修）：`src/server/ark/fixtures.ts` 不再用 `new URL('../../../fixtures', import.meta.url)`（webpack 会静态解析目录并失败），改为 `path.dirname(fileURLToPath(import.meta.url))` + `path.resolve(..., '../../../fixtures')`。构建 21 路由全绿。
- 若干刻意延后项见各 ticket 的 `## Comments`（如 `DB-07` 已在 T09 接线；T06 锚点提取不自动重试是 `modules/M03` 的设计）。
