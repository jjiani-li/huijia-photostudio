# 回家照相馆 · huijia-photostudio

上传一张旧照片，提取人物面部特征作为**身份锚点**，再按用户选定的【年代 × 场景】生成同一个人身处全新场景的写实照片。

> 这是一个**照片重建**产品，不是**老照片修复**产品。任何以「美化 / 修复」为目标的处理，都会在锚点生成之前把人物身份的证据换成 AI 的想象。这条取舍记录在 [`docs/adr/0001-f1-is-feature-extraction-not-restoration.md`](docs/adr/0001-f1-is-feature-extraction-not-restoration.md)。

## 演示效果

下列图片均由本项目的真实链路产出（Doubao 视觉理解提取身份锚点 → Doubao-Seedream 按【年代 × 场景】生成）。

**演示人物为 AI 生成的虚构人物，不对应任何真实个体。** 同一个人的面部特征在三个不同的【年代 × 场景】之间保持了一致——这正是产品要解决的问题。

| 输入｜80-90 年代 × 老式照相馆 | 生成｜50-70 年代 × 家庭客厅 | 生成｜2010-2020 年代 × 城市公园 |
| :-: | :-: | :-: |
| ![输入](docs/output/era-scene-E2-S1-old-studio.png) | ![E1-S4](docs/output/era-scene-E1-S4-living-room.png) | ![E4-S3](docs/output/era-scene-E4-S3-city-park.png) |

## 项目规模（均为可复现的静态统计）

| 指标 | 数值 |
| --- | --- |
| Git 提交 | 78 |
| HTTP 端点 | 25（GET 10 / POST 13 / DELETE 2） |
| 页面 | 7 |
| 测试 | 70 个测试文件，**626 个用例全部通过**（`pnpm test`） |
| 验收检查项 | 89（A 层单测 22 / B 层自动验收 67） |
| 需求工单 | T01–T20，共 20 张 |
| PRD 文档 | 45 份（9 篇模块规格 + 5 篇页面规格 + 9 篇 spec + 20 张工单 + 总纲） |
| 非测试源码 | 约 1.43 万行 TypeScript / TSX |

## 技术栈

Next.js 15 · React 19 · TypeScript · better-sqlite3 · Zod · Vitest · Tailwind CSS

上游模型为火山引擎方舟：Doubao 视觉理解负责面部特征提取，Seedream 负责图像生成。

## 工程方法

- **文档门禁**：`docs/prd/` 是冻结的 PRD。`pnpm check:docs` 会断言检查项 ID、工单索引、被引用的文件与章节、文档里声明的计数四者始终自洽（`scripts/check-docs.mjs` + `docs/prd/spec/check-registry.json`）。改文档不改代码，门禁就会红。
- **决策记录**：影响全局的取舍写进 `docs/adr/`，而不是散落在代码注释里。
- **领域术语表**：`CONTEXT.md` 为每个术语规定唯一叫法，并附 `_Avoid_` 反例，避免同一概念在不同模块里长出多个名字。
- **三层验收**：A 层单测（`pnpm test`）／B 层自动验收（`pnpm check:acceptance`）／C 层盲测（`pnpm check:blind`）。
- **工单制**：20 张工单按依赖排期，每张完成即独立提交，提交信息带工单号。

## 关键实现

- **身份锚点**（`src/jobs/handlers/anchorExtract.ts`）：质量前置校验、容错解析、反美化词表拦截、锚点长度校准到 60–120 字区间；任何异常都必须落到终态，不留悬挂任务。
- **合规与留痕**（`src/server/security/audit.ts`、`src/server/images/mark.ts`）：用户对照片的授权声明永久留痕，只能吊销不能抹除；生成图写入 AIGC 隐式标识（PNG `tEXt` / JPEG EXIF）。标识写入失败不阻断生成，但会记审计。
- **任务编排**（`src/jobs/`）：worker 每 5 秒写一次心跳、15 秒判死；轮转拉取任务、超时竞速；启动时回收遗留的僵尸任务。
- **上游接入**（`src/server/ark/`）：真实调用与 mock 双实现，mock 走 fixture 回放，保证离线可复现——这也是自动化检查唯一的判据来源。

## 本地运行

环境变量的清单与默认值以 [`docs/prd/spec/08-本地开发指南.md`](docs/prd/spec/08-本地开发指南.md) §4 为准。

```bash
cp .env.example .env          # 按需填写，ARK_API_KEY 留空即走 mock 回放
pnpm install
pnpm migrate && pnpm seed
pnpm dev                      # 启动应用
pnpm worker                   # 另开一个终端启动生成 worker
```

检查：

```bash
pnpm test               # 70 个文件 / 626 个用例
pnpm check:acceptance   # 89 项验收检查
pnpm check:docs         # 文档门禁
pnpm check              # typecheck + lint
```

## 开发方式

本项目由我主导：需求定义、领域建模、PRD 与接口契约、验收标准、工单拆解与逐张评审。编码工作由 Kimi Code CLI 作为结对工程师完成，提交历史如实记录了这一点。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `app/` | Next.js 路由与 API 端点 |
| `components/` | 前端组件 |
| `src/server/` | 领域服务、HTTP 层、鉴权、Ark 接入、审计、图片处理 |
| `src/jobs/` | 生成任务编排与 worker |
| `docs/prd/` | 冻结的 PRD：模块规格、页面规格、接口契约、验收标准 |
| `docs/adr/` | 架构决策记录 |
| `docs/agents/` | 协作约定：问题跟踪、分类标签、领域文档规范 |
| `.scratch/` | 施工过程留痕：契约冻结记录、迁移映射、上游能力核验 |
| `scripts/` | 三层验收脚本与文档门禁 |
| `CONTEXT.md` | 领域术语表 |

## 第三方声明

`.agents/skills/` 下的技能包来自 [mattpocock/skills](https://github.com/mattpocock/skills)，是第三方资产（MIT），**不是本项目的产出**，仅在本项目的开发流程中被调用。`skills-lock.json` 记录了来源与哈希。

## 说明

- 仓库内不含任何真实密钥，`.env.example` 中 `ARK_API_KEY` 留空。
- `docs/output/` 下的图片用于效果确认与演示：`arkcli-*`、`seedream-lite-*` 是模型与 CLI 的能力测试图（笔记本、柴犬），`era-scene-*` 是本项目的生成产出。
- **仓库内不含任何真实人物的照片**；所有演示人物均为 AI 生成的虚构人物。
