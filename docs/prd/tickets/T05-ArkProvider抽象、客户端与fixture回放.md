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
- [待定决策 → 已定] **`ArkProvider` 的 DTO 定稿**（供 `tickets/T06` / `tickets/T10` 引用）：`extractAnchor(input: { images: { mime, base64 }[]; systemPrompt }): Promise<{ anchorText, features: AnchorFeatures, model }>`；`generateImage(request: { prompt, images: string[]; size, outputFormat: 'png'|'jpeg', watermark, count }): Promise<{ images: { url, size, seed }[]; model }>`。`AnchorFeatures` 12 键已进 `src/shared/types.ts`（`spec/03` §4 的形状）。
- [待定决策 → 已定] **mock 的确定性选图键**：`modules/M06-生成编排.md` §5.9 规定 `generateImage` 只收 `{ prompt, images, size, outputFormat, watermark, count }`，**不携带 `anchorId/eraCode/sceneId`**，故按 `hash(prompt + ordinal)` 在 `fixtures/images/` 的 3 张里确定性选图（`prompt` 是 era/scene/anchor 的确定性函数，效果等价）；读图年龄按 `hash(输入 base64)` 稳定替换。
- [待定决策 → 已定] **mock 的「未知场景」与失败分支**：接口不含 era/scene，无法按场景判断，落成 prompt 里的显式标记 `MOCK_UNKNOWN_SCENE_MARKER`（`__MOCK_UNKNOWN_SCENE__`）触发 `PROVIDER_ERROR`；三个失败样本用 `MockArkProvider.setFailure('invalid-size'|'model-not-open'|'timeout')` 显式指定（`spec/08` §5.1）。
- [待定决策] **mock 的落盘职责**：`spec/08` §5.1 写「写入本地存储后返回本地 URL」，而 `modules/M06` §5.9 ③ 把「下载 → 探宽高 → 写标识 → 落 `photos`」放在 handler。本条让 mock 返回 `fixtures/images/` 的路径、**不落盘**，转存与 `photos` 落库归 `tickets/T10`。影响面：`spec/08` §5.1 的措辞与 `tickets/T10` 的 handler。
