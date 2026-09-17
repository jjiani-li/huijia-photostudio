# NEXT · 接着干

> 会话交接说明。仓库：`D:\桌面\wt-20260915\day3`（Windows；Bash 工具走 Git Bash，用 Unix 语法）。
> **pnpm 不在 PATH 上**（`corepack enable` 在这个环境需要管理员权限），一律用 `corepack pnpm <script>`。

## 现在在哪

- **契约单点化系列**（`.scratch/contract-freeze/`，spec 为 `spec.md`）：**01–08 已交付**，Status 均为 `ready-for-human`，工作树干净、全部已提交。
- **下一张：`09-历史与结果页口径.md`**（Status `ready-for-agent`），之后 10 页面形态与文案清单、11 合规与差异登记。
- **产品侧**（`docs/prd/tickets/`）：只做了 T01（脚手架 + 四个横切层，提交 `606ed08`/`21e2915`）；**下一张是 T02 数据层**（迁移、schema、种子、11 个 repository、`migrate`/`seed`/`db:reset` 脚本）。

## 工具现状（改动它们要同步 `docs/prd/spec/08-本地开发指南.md` §3.3 与脚本头部注释）

- `docs/prd/spec/check-registry.json`：89 条检查项（B 67 / A 22）。
- `scripts/check-docs.mjs`：13 条静态断言；`--root` 指夹具树、`--write-index` 按工单表头重写 `tickets/README.md` 的检查项列。
- `scripts/check-docs.test.mjs`：40 个夹具用例（新增断言必须配用例）。
- 产品骨架：Next 15 + TS strict + vitest（17 个用例）+ eslint/tsconfig/`package.json`。

## 一条 ticket 的做法（01–07 都按这个走）

1. 读 `.scratch/contract-freeze/issues/NN-*.md` 的清单 + `spec.md` 里对应的裁定。
2. 收敛文档（跨多个文件时可把「同一类、互不重叠的文件」分包给子代理并行做，然后统一验证）。
3. 清单要求断言的，就加/改闸门断言 + 夹具用例；改完文档树必须全绿。
4. 跑齐：`corepack pnpm check:docs`、`corepack pnpm test:docs`、`corepack pnpm test`、`corepack pnpm check`。
5. 提交（提交信息写清「按 issue 的清单做了什么、哪些条款已在前几轮收口只是核对、评审追加项」）。
6. 用 `/code-review` 的两轴（Standards / Spec）子代理评审本次 diff，按意见收口后再提交一次。
7. 把 issue 的复选框勾上、`Status` 改 `ready-for-human`，在 `## Comments` 里写交付记录与偏离说明。
8. **停下汇报，等人工确认再进下一章**——一章一停：交付（提交 + 勾清单 + `ready-for-human`）后向用户汇报本章结果、偏离项与下一章是什么，**等用户回复「同意」再开下一张**，不自行续跑。

## 直接发给我的话

热会话（上下文还在）：

```
/implement spec ticket06
```

冷启动（新会话、上下文已清）：

```
在 D:\桌面\wt-20260915\day3 继续做「契约单点化」系列。先读 .scratch/contract-freeze/NEXT.md
与 issues/09-历史与结果页口径.md，按前八张 ticket 的做法实现它：收敛文档、必要时加闸门断言、
跑 corepack pnpm check:docs / test:docs / test / check、提交、再跑 /code-review 两轴评审并收口、
最后勾清单并把 Status 改成 ready-for-human。**一章一停**：交付后停下汇报，等我回复同意再进下一章。
```

想改做产品线就说：`/implement docs/prd/tickets`（下一次是 T02）。
