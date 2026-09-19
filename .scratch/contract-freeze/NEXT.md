# NEXT · 接着干

> 会话交接说明。仓库：`D:\桌面\wt-20260915\day3`（Windows；Bash 工具走 Git Bash，用 Unix 语法）。
> **pnpm 不在 PATH 上**（`corepack enable` 在这个环境需要管理员权限），一律用 `corepack pnpm <script>`。

## 现在在哪

- **产品线**（`docs/prd/tickets/`）：**T01–T19 已全部交付并两轴收口**，工作树干净（除下方「无关改动」），全部已提交：
  - T01 脚手架 · T02 数据层 · T03 照片资产 · T04 预处理/评分 · T05 ArkProvider · T06 身份锚点 · T07 身份确认/授权 · T08 年代场景配置与 Prompt 拼装 · T09 生成编排 · T10 生图调用与结果转存 · T11 生成后复核与内容审核 · T12 账号/会话/额度 · T13 历史/再生成/彻底删除 · T14 前端基础（Token/外壳/通用组件/`/login`）· T16 年代 × 场景选择（前端）· T17 生成结果、历史与下载（前端）· T18 图片反推提示词（F4）· T19 实名、用户资料与生成门槛 · **T15 前端：上传 → 预处理 → 身份确认**。
- **开工顺序（已确认，固定）**：`T18` → `T16` → `T17` → `T19` → `T15` → **`T20`**。
  - 依据 `tickets/README.md` §1 依赖图：只剩 **`T20`**（最终验收收口，依赖全部）。
- **下一张是 `T20`**：`docs/prd/tickets/T20-*.md`。开工前先看下条「T16 的 `/choose` 阻断」——它会让 UI 走不完「确认 → 年代场景选择」。
- **T16 的 `/choose` 阻断（T15 交付时浏览器实测发现，按 `spec/09` §3 只记录未改）**：`components/choose/choose-panel.tsx` 的 `loadAnchor` 把 `{ anchor }` 信封直接当 `Anchor` 用（没取 `.anchor`），`shouldRedirectToConfirm` 因此恒为真 → 无论锚点是否已确认都 `router.replace` 回 `/confirm/[anchorId]`。一行修法：`apiRequest<{ anchor: Anchor }>(...)` 后 `.then((res) => res.anchor)`；修完请补一条容器级的守卫断言（或浏览器实测），`tickets/T16` 的 `## Comments` 记一条跨票同步。
- **工作规则不变**：收敛文档 → 按清单加/改闸门断言与夹具用例 → 跑齐 `corepack pnpm check:docs / test:docs / test / check`（外加该 ticket 的 `migrate && seed && check:acceptance`）→ 提交 → `/code-review` 两轴评审并收口 → 写 `## Comments`。**每完成一张 ticket 就暂停汇报，等人工明确同意再开下一张。**
- **契约单点化系列**（`.scratch/contract-freeze/`）：01–11 已全部交付并置 `ready-for-human`，没有下一张。

## 工具现状（改动它们要同步 `docs/prd/spec/08-本地开发指南.md` §3.3 与脚本头部注释）

- `docs/prd/spec/check-registry.json`：89 条检查项（B 67 / A 22）。
- `scripts/check-docs.mjs`：17 条静态断言；`--root` 指夹具树、`--write-index` 按工单表头重写 `tickets/README.md` 的检查项列。
- `scripts/check-docs.test.mjs`：50 个夹具用例（新增断言必须配用例）。
- `scripts/acceptance.ts`：B 层执行器，现输出 **58 passed, 0 failed**（进程内直连 domain/端点，自带清理；`CMP-06` 是静态扫描：语义句落点 + 会话态不落 web storage；`API-09` / `RN-01`–`RN-04` 直调实名端点与 `createGeneration`；**`E2E-01` 随 T15 补齐**——全链路含真实老照片上传、preprocess、锚点、confirm、生成、历史与下载）。⚠️ 注册表 67 项 B 层里仍有 **9 项未实现**（`API-01`、`API-02`、`API-04`、`E2E-02`、`E2E-03`、`SEC-06`、`ERR-03`、`E2E-10`、`CMP-02`，多数归 `tickets/T20`）——`T20` 收口前必须补齐或逐条说明。
- 产品骨架：Next 15 + TS strict + vitest（**70 文件 / 626 用例**）+ eslint/tsconfig/`package.json` + Tailwind（`tailwind.config.ts` 为 Token 唯一落点）。

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
docs/prd/tickets/T20-*.md，按 docs/prd/spec/09-施工纪律.md 的施工纪律与 T01–T19 的既有做法
实现 T20（最终验收收口）：收敛文档、按清单加/改闸门断言与夹具用例，完整跑
corepack pnpm check:docs / test:docs / test / check 与 check:acceptance，提交，再跑 /code-review
两轴评审并收口。**一章一停**：交付后停下汇报，等我回复同意再进下一章。
（开工前先处理 NEXT.md 里记的「T16 的 /choose 阻断」。）
```

（开工顺序固定为 `T18 → T16 → T17 → T19 → T15 → T20`；`T19` 与 `T15` 已互换执行，只剩 `T20`。）

## 已知遗留 / 注意事项（不必现在处理）

- `docs/提示词.md` 在工作树里显示为已修改：这是**先前的无关改动**（提示词原始素材），历次交付都没动它、也没提交，忽略即可。
- `ERR-01` / `ERR-05` 已随 T10 补齐；`E2E-01` 随 T15 补齐；`E2E-02`（`T06`）/ `E2E-03`（`T08`）/ `E2E-10`（`T20`）仍未实现（`E2E-02` 有 `src/jobs/handlers/anchorExtract.test.ts` 的 A 层旁证，`E2E-03` 有 `src/server/prompt/build.test.ts` 的旁证）——`T20` 收口时按注册表逐条补齐或写清口径。
- **`T15` 交付的两处跨票同步**：① `components/auth-guard.tsx` 对 `/` 跳过软重定向（首页是公开页，`pages/P00` §5.1 规则 ③ 已加例外）；② `ERROR_MESSAGE` 从 `src/server/domain/errors.ts` 上提到 `src/shared/error-message.ts`（前后端共用一份，`spec/04` §4.1/§2、`pages/P00` §8、`pages/P01` §7 同步）——`toErrorNotice` 因此会为网络级失败给兜底文案，`hooks/use-job-polling.test.ts` / `src/shared/api-client.test.ts` 的期望值已同步。
- **T16 的 `/choose` 阻断**（见「现在在哪」）：`components/choose/choose-panel.tsx` 的 `loadAnchor` 少取一层 `.anchor`，`/choose/[anchorId]` 在 UI 上不可达；一行可修，修完补断言并在 `tickets/T16` 记跨票同步。
- `DEL-01`–`DEL-04` / `CMP-05` 随 T13 补齐、`CMP-06` 随 T17 补齐；`/api/history` 的 `url` 带 `?w=400`、`deletePhoto` 对「已物理清理的行」按 `spec/03` §1.5 返 `200`（幂等）是 `modules/M08` §9 已收口的口径。
- **`pnpm build` 已随 `tickets/T05` 的 fixtures 路径修复转绿**（T14 会话发现、经人工同意修）：`src/server/ark/fixtures.ts` 不再用 `new URL('../../../fixtures', import.meta.url)`（webpack 会静态解析目录并失败），改为 `path.dirname(fileURLToPath(import.meta.url))` + `path.resolve(..., '../../../fixtures')`。构建 **27 路由**全绿（T18 两个反推端点 + T16 的 `/choose/[anchorId]` + T17 的 `/result/[generationId]`、`/history` + T19 的 `/api/me/realname`）。
- `CMP-06` 的断言落点在 `scripts/acceptance.ts`（静态扫描）；`WorkerNotice` 已从 `components/provider-badge.tsx` 移到 `components/worker-notice.tsx`，`loginPath` / `hasUnauthenticated` 已移到 `src/shared/session.ts`（跨票同步记在 `tickets/T17` 的 `## Comments`）。
- `API-09` / `RN-01`–`RN-04` 随 T19 补齐；`ID_VERIFY_PROVIDER=real` 抛 `INTERNAL`（生产留空位），实名的证件号规则取 GB 11643 的 18 位 + ISO 7064 MOD 11-2 校验位，口径记在 `tickets/T19` 的 `## Comments`。
- 若干刻意延后项见各 ticket 的 `## Comments`（如 `DB-07` 已在 T09 接线；T06 锚点提取不自动重试是 `modules/M03` 的设计；T18 的 `CONTENT_REJECTED` 因上传阶段即软删被拒照片而不可达，口径记在该 ticket 的 `## Comments`）。
