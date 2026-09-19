# T05 · Ark Provider 抽象、客户端与 fixture 回放

| 项 | 值 |
|---|---|
| 阶段 | M1 |
| 依赖 | `T01` |
| 必读文档 | `modules/M06-生成编排.md` §5、`spec/08-本地开发指南.md` §5 |
| 检查项 | `ERR-03` |

## 1. 目标
读图（`extractAnchor`）与生图两条上游调用收敛到 `ArkProvider` 之下：`PROVIDER=mock` 离线可回放，`PROVIDER=real` 直连 HTTP；上游错误到本项目错误码只有一个映射入口（`mapArkError`）。

## 2. 不做（边界）
- 不做生成编排 / worker / 终态 / 额度（归 `tickets/T09-生成编排：任务、worker、轮询、重试、额度.md`）；不做隐式标识写入（归 `tickets/T10-Seedream生图调用与结果转存.md`）。
- 不实现 `/responses` 通道、arkcli 与 Endpoint 方式（`spec/08-本地开发指南.md` §5.2）；不新增环境变量。

## 3. 要交付的文件
| 路径 | 新建/修改 | 职责 | 依据 |
|---|---|---|---|
| `src/server/ark/types.ts` | 新建 | `ArkProvider` 接口与 DTO（`AnchorExtractInput/Result`、`ArkImageRequest/Result`） | `modules/M03-身份锚点提取.md` §5.4、`modules/M06-生成编排.md` §2 |
| `src/server/ark/real.ts` | 新建 | `RealArkProvider`：`chat/completions`（messages 组装见 §5.4）与 `images/generations` | `spec/08-本地开发指南.md` §5.2 |
| `src/server/ark/mock.ts` | 新建 | `MockArkProvider`：fixture 回放、确定性选图、300–800ms sleep、未知场景抛 `PROVIDER_ERROR` | `spec/08-本地开发指南.md` §5.1 |
| `src/server/ark/errors.ts` | 新建 | `mapArkError()`：上游 8 类 → `ErrorCode` + `retryable` | `modules/M06-生成编排.md` §5.8 |
| `src/server/ark/index.ts`、`fixtures/ark/*.json`、`fixtures/images/*` | 新建 | `getArk()`；fixture 骨架与 3 张真实样本图（`spec/08` §5.1 共 9 个，其中第 9 个 `prompt-reverse.json` 归 `tickets/T18`） | `spec/08-本地开发指南.md` §5.1 |

## 4. 实现要点
1. `getArk()` 按 `PROVIDER` 返回进程内单例；业务代码只依赖 `ArkProvider` 接口，不得直接 `fetch`（`spec/08-本地开发指南.md` §5.1）。
2. mock 四条硬规则：读图的 `features.ageRange` / `anchorText` 按**输入文件名**稳定替换；生图按 `(anchorId + eraCode + sceneId + ordinal)` 哈希确定性选图；每次调用 sleep 300–800ms；`fixtures` 中不存在的场景抛 `PROVIDER_ERROR`。
3. `mapArkError()` 判定顺序：先 `error.code`，再看 HTTP 状态，最后落 `INTERNAL`；返回体 `model` 不得用于断言（`modules/M06-生成编排.md` §5.8）。real 模式直连 HTTP + 模型名。

## 5. 完成判定
```bash
pnpm test
```
- 单测断言 `mapArkError` 逐条 `code` / `retryable`（`ERR-03`：`fixtures/ark/invalid-size.json` → `INTERNAL` 且不重试，`model-not-open.json` → `PROVIDER_ERROR` 不重试，`timeout.json` → `PROVIDER_TIMEOUT` 可重试）；`ERR-01` 需要 worker 才能端到端复现，形态在 `tickets/T09` 的完成判定里转绿；通用项见 `spec/07-验收标准.md` §5。

## 6. 待定决策
`ArkProvider` 的方法名与 DTO 形状（如 `extractAnchor` / `generateImage`）由本条在 `src/server/ark/types.ts` 定稿，供 `tickets/T06`、`tickets/T10` 引用（`modules/M03-身份锚点提取.md` §9 第 7 条等待收口）。
## Comments

- [实现记录] 交付：`src/server/ark/{types,errors,fixtures,mock,real,index}.ts`；`fixtures/ark/` 8 个 JSON（`anchor-extract` / `anchor-extract-fail` / `image-generation` / `invalid-size` / `model-not-open` / `timeout` / `era-check` / `safety-review`，第 9 个 `prompt-reverse.json` 归 `tickets/T18`）；`fixtures/images/generated-01..03.png`（自 `docs/output/` 复制 3 张）。验收：`pnpm typecheck` / `pnpm lint` 零错误；`pnpm test` **81** 用例全绿（新增 13 条：`mapArkError` 逐条 + mock 确定性）；`pnpm check:docs` / `pnpm test:docs` 全绿。
- [待定决策 → 已定] **`ArkProvider` 的 DTO 定稿**（供 `tickets/T06` / `tickets/T10` 引用）：`extractAnchor(input: { images: { mime, base64 }[]; systemPrompt }): Promise<{ raw: string; model: string }>`（`raw` 是上游助手正文原文、**未解析**；六步容错解析归 handler，见 `modules/M03-身份锚点提取.md` §5.3 步骤 4，`tickets/T06` 收口时把原 `{ anchorText, features, model }` 改为此形状）；`generateImage(request: { prompt, images: string[]; size, outputFormat: 'png'|'jpeg', watermark, count }): Promise<{ images: { url, size, seed }[]; model }>`。`AnchorFeatures` 12 键已进 `src/shared/types.ts`（`spec/03` §4 的形状）。
- [待定决策 → 已定] **mock 的确定性选图键**：`modules/M06-生成编排.md` §5.9 规定 `generateImage` 只收 `{ prompt, images, size, outputFormat, watermark, count }`，**不携带 `anchorId/eraCode/sceneId`**，故按 `hash(prompt + ordinal)` 在 `fixtures/images/` 的 3 张里确定性选图（`prompt` 是 era/scene/anchor 的确定性函数，效果等价）；读图年龄按 `hash(输入 base64)` 稳定替换。
- [待定决策 → 已定] **mock 的「未知场景」与失败分支**：接口不含 era/scene，无法按场景判断，落成 prompt 里的显式标记 `MOCK_UNKNOWN_SCENE_MARKER`（`__MOCK_UNKNOWN_SCENE__`）触发 `PROVIDER_ERROR`；三个失败样本用 `MockArkProvider.setFailure('invalid-size'|'model-not-open'|'timeout')` 显式指定（`spec/08` §5.1）。
- [待定决策] **mock 的落盘职责**：`spec/08` §5.1 写「写入本地存储后返回本地 URL」，而 `modules/M06` §5.9 ③ 把「下载 → 探宽高 → 写标识 → 落 `photos`」放在 handler。本条让 mock 返回 `fixtures/images/` 的路径、**不落盘**，转存与 `photos` 落库归 `tickets/T10`；`spec/08` §5.1 的措辞已按实际实现同步。影响面：`spec/08` §5.1 与 `tickets/T10` 的 handler。
- [实现记录] **两轴评审收口**（`/code-review`，Standards + Spec）：① mock 的年龄替换正则 `\d+岁` → `\d+\s*岁`（fixture 是「大约 60 岁」，原正则匹配不到、年龄实际从未替换）；② `mapArkError` 去掉自创的「401/403 → INTERNAL」分支，统一落 `modules/M06` §5.8 的「其他 HTTP 4xx → `PROVIDER_ERROR` ❌」；③ `real.ts` 的 `seed` 改为**上游回传才记录**（原来硬写 `null`）；④ 两个 anchor fixture 改回锚点形状（`promptVersion` + `quality`；fail 样本 `quality.usable=false` 触发 `ANCHOR_LOW_QUALITY`），删掉 mock 里随之失效的 null 分支；⑤ 删掉未用的导出 `MOCK_FAILURE_IDS` / `fixturePath`；⑥ `spec/08` §5.1 的 mock 行为规则按实际实现重写（选图键 `hash(prompt+ordinal)`、年龄按输入哈希、未知场景标记、不落盘）——`spec/09` §5.5：契约级分歧回改 `spec/` 而非留成待定。收口后 `pnpm test` **81** 用例全绿。
- [待定决策] **`outputFormat` 不下发上游**：`ArkImageRequest.outputFormat` 只记进 `generations.params_json`（`spec/01` §3.4 的 `generated` mime 来源），`real.ts` 的请求体不带它——上游没有对应的「输出格式」参数（`docs/火山引擎接口文档.md` 未列），实际格式由转存时 `probeImage()` 探出。影响面：`modules/M06` §5.9 ② 的请求体字段。
- [修复记录] **`fixtures.ts` 的路径表达式改 webpack 安全写法**（`tickets/T14` 会话发现，经人工同意后修）：原 `fileURLToPath(new URL('../../../fixtures', import.meta.url))` 会让 webpack 把该**目录**当静态资源解析并报 `Can't resolve`，导致 `pnpm build` 与 `pnpm dev` 访问 `/api/anchors*` 直接失败。改为 `path.dirname(fileURLToPath(import.meta.url))` + `path.resolve(MODULE_DIR, '../../../fixtures')`——保持不依赖 cwd，同时绕开 webpack 的静态解析。`pnpm build` 全绿（21 路由），`pnpm test` 338 / `check:acceptance` 47 不受影响。
- [待定决策 → 已收口] **`anchor-extract-fail.json` 的消费位置**（`tickets/T06` 收口）：`ANCHOR_LOW_QUALITY` 是**提取前的质量前置判定**（`modules/M03-身份锚点提取.md` §6.1），读的是 `photos.quality_json`（`POST /api/photos/:id/preprocess` 的产物），**不经过读图调用**——`MockArkProvider.extractAnchor` 的输入/输出里没有质量字段，故没有回放该 fixture 的通道。其 `quality.usable = false` 由 `app/api/anchors/routes.test.ts` 作为 §6.1 的低质量样本写入 `photos.quality_json`，再断言 `GET /api/anchors/:id` 返回 `failed` + `ANCHOR_LOW_QUALITY` + `quality`（等价于「回放该 fixture」）。影响面：`tickets/T06` 的提取流程。
