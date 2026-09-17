# 05 · Prompt 工程

> **层级**：规范层 · 全局约束（不可违背）
> **上游**：`docs/raw/AIGC_PRD.md` §2、§5.8、§7 ／ `spec/00-总纲.md`
> **下游**：`modules/M03-身份锚点提取.md`、`modules/M05-年代场景配置与Prompt拼装.md`、`modules/M07-生成后复核与内容审核.md`、`modules/M09-图片反推提示词.md`、`tickets/T06-身份锚点提取.md`、`tickets/T08-年代场景配置与Prompt拼装.md`、`tickets/T11-生成后复核与内容安全审核.md`、`tickets/T18-图片反推提示词.md`

**铁律**：业务代码中**不得内联任何 prompt 文本**；所有 prompt 由「模板 + 种子数据」拼装，`buildPrompt` 是唯一入口。

---

## 1. 为什么 prompt 是本产品的核心资产

`doubao-seedream-5-0-lite-260128` **不支持负向提示词**，禁止项没有负向通道，因此本项目的 prompt 工程 = **「正向写实锚定 + 禁止项正面化」**：任何 `不要…`／`no xxx` 的写法都无效，必须改写。

## 2. 拼装结构（模板 `tpl-v1`）

> **本节只写结构与约束**：段落顺序、段落职责、变量与可空性。**正文的唯一事实源是代码**——`src/server/prompt/template.ts` 的段落标签常量与 `IDENTITY_LEAD` / `AGE_PRESERVE_CLAUSE` / `REALISM_ANCHOR`（`tickets/T08-年代场景配置与Prompt拼装.md`），种子侧的 `agePreserveClause` / `realismAnchor` 以 `spec/era-scene-seed.json` 顶层为准。下方示意块里的文字**不是可复制的正文**，它与代码的等值由 `PR-10` 断言；三者不一致时以代码为准并同步本节。

```
【身份锚点】严格保持参考图中人物的面部特征与身份一致，不同场景之间必须是同一个人：<anchor_text>

【年龄保真】严格保留人物的真实年龄特征：保持源照片中已有的深皱纹、法令纹、眼角纹、老年斑与皮肤松弛，
            不做任何美化、磨皮与减龄处理；面部结构、脸型与体型比例不做任何修饰。

【年代】<era.prompt_pack>

【场景】<scene.space_pack>

【质感】真实照片，随手拍的生活照，自然皮肤纹理，可见毛孔与细纹，真实肤色不均，
        柔和的对比度，构图自然不刻意

【年代一致】<era.constraint_pack>

【组合微调】<profile.prompt_override>      ← 为 NULL 时整段省略
```

### 2.1 段落职责

| 段落 | 来源 | 变量 | 可否为空 |
|---|---|---|---|
| 【身份锚点】 | `identity_anchors.anchor_text` | ✅ | ❌ 必填，缺失即拒绝生成 |
| 【年龄保真】 | 模板常量 | ❌ | 不可删除（`docs/prd/README.md` §0.3 的链路级约束） |
| 【年代】 | `eras.prompt_pack` | ✅ | ❌ |
| 【场景】 | `scenes.space_pack` | ✅ | ❌ |
| 【质感】 | 模板常量（写实锚定词） | ❌ | 不可删除 |
| 【年代一致】 | `eras.constraint_pack` | ✅ | ❌ |
| 【组合微调】 | `era_scene_profiles.prompt_override` | ✅ | ✅ 为空则省略 |

### 2.2 拼装函数契约

唯一入口（实现在 `modules/M05-年代场景配置与Prompt拼装.md`）：

```ts
buildPrompt(input: {
  anchorText: string;
  era: EraRecord;
  scene: SceneRecord;
  profile: EraSceneProfileRecord | null;
}): { prompt: string; promptHash: string; templateVersion: string }
```

- 段落之间用**单个换行**分隔，段落内部保留原文换行与缩进，不做 trim 合并；
- 段落顺序**固定**，不得调整（顺序影响模型注意力）；
- `prompt_hash` = 对最终 prompt 全文取 sha256（十六进制小写），用于 A/B 与去重；
- 返回值同时带 `templateVersion`，写进 `generations.template_version`。

## 3. 禁止项的正面化改写表

> 这张表是 `eras.constraint_pack` 与写实锚定词的**编写依据**；新增年代包时必须逐条检查，所有禁止项都要有对应的正向表达。

| 想禁止 | ❌ 失效写法 | ✅ 正面化改写 |
|---|---|---|
| 塑料感 / 蜡像感 | `不要塑料感` | 自然的皮肤光泽、轻微油光、真实的肤色过渡 |
| 过度磨皮 | `no smooth skin` | 保留皮肤真实纹理、毛孔、细纹、法令纹 |
| 3D 渲染感 | `不要 CG` | 写真摄影质感、纪实摄影 |
| 过度锐化 / HDR | `不要 HDR` | 柔和的对比度、略低的动态范围、轻微失焦 |
| 影楼摆拍 | `不要摆拍` | 随意的生活抓拍、不完美的构图 |
| **把老人磨年轻** | `不要减龄` | 保留已有的深皱纹、老年斑与皮肤松弛，不做任何美化与减龄处理 |
| 现代建筑穿帮 | `不要现代建筑` | 背景建筑为 1980—1990 年代的砖混楼房，外墙为水泥或马赛克贴面 |
| 智能手机穿帮 | `不要智能手机` | 画面中的通讯设备为 1980 年代常见的固定电话，或画面中不存在通讯设备 |
| E1 出现彩色 | `不要彩色` | 黑白照片，全画面无彩色，仅极轻微泛黄 |

## 4. 防美化约束（链路级，三处落点）

「不能把老人磨年轻」是本产品最容易翻车的地方——模型天然倾向理想化。**三处必须同时存在，缺一不可**（`docs/prd/README.md` §0.3 依赖本节）：

| # | 落点 | 具体内容 | 归属（模块 / 工单） |
|---|---|---|---|
| 1 | **锚点提取的 system prompt** | 要求写出皱纹深度、位置、老年斑数量与分布、皮肤松弛程度；明确禁止"慈祥""有气质""精神矍铄"这类**美化性词汇** | `modules/M03-身份锚点提取.md` ／ `tickets/T06-身份锚点提取.md` |
| 2 | **生成 prompt 的【年龄保真】段** | 模板常量，`spec/05-Prompt工程.md` §2 已定义，**不可省略** | `spec/05-Prompt工程.md` §2 ／ `tickets/T08-年代场景配置与Prompt拼装.md` |
| 3 | **生成后的年龄偏差检查** | 用多模态模型估计生成图人物年龄，与锚点的 `ageRange` 中值比较，写入 `age_delta`；`|age_delta| > 5` 在图卡上给出"年龄偏差提示" | `modules/M07-生成后复核与内容审核.md` ／ `tickets/T11-生成后复核与内容安全审核.md` |

**反例（必须避免）**：❌ `"慈祥的老年男性，精神矍铄，面容温和"`

**正例**：✅ `"75-85岁老年男性，留灰白短寸发型，发际线明显后退，额头宽阔有深横纹，方圆脸，细长单眼皮带眼袋，鼻头圆润嘴唇偏薄，面部有明显皱纹与少量老年斑，体型瘦高，无明显特殊痣疤"`

差别在于：**正例全部是可视觉验证的客观描述，且不修饰年龄痕迹**。

## 5. 年代包编写规范

每个 `prompt_pack` 必须覆盖五个维度，缺一不可（`style_json` 是同一信息的结构化镜像）：

| 维度 | 说明 | 示例（E2） |
|---|---|---|
| 母题 | 影像类型的总称 | 1980—1990 年代的彩色胶卷照片 |
| 色调 | 偏色方向与饱和度 | 偏青或偏暖红，浓郁但不艳丽 |
| 颗粒/画质 | 噪点与颗粒 | 明显彩色颗粒与轻微色染，边缘轻微色散 |
| 动态范围与光比 | 高光/暗部行为 | 闪光灯直打时高光轻微溢出 |
| 器材特征 | 相机类型与操作痕迹 | 135 胶片机，傻瓜相机直出 |

**禁止**：年代包中不得出现"胶片"字样以外的**跨年代词汇**。E3/E4 属于数码/手机年代，写"胶片质感"会与年代包冲突——写实锚定词自身不含"胶片"字样，正是为了避免这个问题。

## 6. 场景包编写规范

场景是**跨年代的中性空间**：同一场景包在 E1 与 E4 下都要成立，年代差异由年代包与组合微调承担。因此 `space_pack` **不得**包含年代特定物件（如"搪瓷缸""饮水机"）、年代特定材质（如"瓷砖地"）或年代特定色彩倾向——这些一律下沉到 `era_scene_profiles.prompt_override`。

每个 `space_pack` 必须覆盖四个维度：

| 维度 | 说明 | 示例（S3） |
|---|---|---|
| 空间元素 | 环境中的固定物件 | 草坪与河道或湖面、成排树木、长椅、步道与铁栏杆 |
| 光源 | 光的方向与性质 | 自然日光或阴天散射光 |
| 构图/视角 | 机位与人在画面中的位置 | 平视或略仰视的日常拍摄视角 |
| 景深层次 | 远中近景 | 远中近景层次清晰，人物与环境自然融合 |

---

## 7. 版本管理

### 7.1 版本号载体

| 资产 | 版本字段 | 当前值 |
|---|---|---|
| prompt 模板结构 | `generations.template_version` | `tpl-v1` |
| 年代包 | `eras.pack_version` | `v1` |
| 场景包 | `scenes.pack_version` | `v1` |
| 锚点提取 system prompt | `identity_anchors.prompt_version` | `anchor-v1` |

### 7.2 变更规则

1. 修改任何包的**文本**，必须**递增对应 `pack_version`**（`v1` → `v2`）；
2. 变更后必须重跑 `spec/07-验收标准.md` 的检查项，并在该 ticket 的 `## Comments` 记录结论；
3. `generations` 行冗余保存了当时的 `template_version` / `era_pack_version` / `scene_pack_version`，并**全文保存了拼装结果 `prompt` 与全部生图参数**，因此历史结果可追溯、**可重新提交复现**——即使年代包已升级。注意口径：这是"可重新提交同一组输入"的可复现，**不承诺逐位相同的出图**——`seed` 参数是否被上游接受并回传尚未验证，见 `tickets/T10-Seedream生图调用与结果转存.md` 的 `## Comments`；
4. 不做自动回滚。要回滚就把旧版本文本重新写回并把版本号 +1（保留变更轨迹）。

### 7.3 种子数据与版本的关系

`spec/era-scene-seed.json` 的顶层有 `version` 字段（如 `seed-v1`），与各包的 `pack_version` 独立。种子文件是**权威副本**，数据库中的 `eras`/`scenes`/`era_scene_profiles` 是它的落地。修改顺序永远是：**先改种子文件 → 递增 pack_version → `pnpm seed`**。

## 8. 组合微调（`prompt_override`）的写法

`prompt_override` 是**唯一的"20 组差异化"手段**，但它是可选且默认大面积为空的：

1. **默认全部为 NULL**。只有当某个组合的实测结果明显不对，才写内容；
2. 内容应当是**短句**，只补充年代包与场景包都没覆盖到的、该组合独有的视觉特征。例如 E4×S1（2020 年代还去照相馆）：
   > `"室内混合光环境，白平衡偏黄，背景布景略显杂乱与陈旧，画面带有手机随手抓拍的不经意感"`
3. **不得**在 `prompt_override` 里重复年代包或场景包已有内容；
4. `prompt_override` 不单独设版本号，随 `era_scene_profiles` 行一起变更（该表无版本列，变更记录靠 git 与 `## Comments`）。

## 9. 长度与结构约束

- 拼装后的完整 prompt 长度区间以 `spec/07-验收标准.md` §2 的 `PR-07` 为**唯一阈值声明**，本节不复述数字；
- 实测参考：E4×S3 的成品 prompt 约 640 字，效果正常（落在该区间内）；
- 拼装函数输出后应断言该区间，超出时在 worker 日志里 warn（**不阻断**生成）。

## 10. 本期不做（留扩展位）

| 不做项 | 原因 | 扩展位 |
|---|---|---|
| 用户可编辑 prompt | 与"用户只选年代与场景"的定位冲突 | `generations.prompt` 已全文落库，将来加只读展示页零成本 |
| 自动 prompt 优化（LLM 改写时代包） | 不可控，破坏可复现性 | `buildPrompt` 是唯一入口，将来可在其后插入一步 |
| 负向提示词通道 | 模型不支持 | 若将来换模型支持，只需在 `buildPrompt` 增加一个返回字段，正文规则不变 |
| 组合级 A/B 分流 | 本期无流量 | `prompt_hash` 已落库，A/B 只需加分组逻辑 |

---

## 11. 图片反推提示词的输出规范（F4）

F4 读一张旧照片，产出**一个可直接采纳的起点**：结构化描述 + 自然语言 prompt + 推荐的年代代号与场景 id。**该输出不写入 `identity_anchors`**——它不是身份锚点，只用于降低用户自己写 prompt 的门槛（见 `modules/M09-图片反推提示词.md`）。

**模型与通道**：`doubao-seed-2-1-turbo-260628`，走 `POST /api/v3/chat/completions` + `image_url` 多模态通道（已实测可用，见 `docs/火山引擎接口文档.md` §3.1），与 `modules/M03-身份锚点提取.md` 复用同一条读图通路。

**输出字段**（落 `prompt_reverse_jobs`，端点见 `spec/03-接口契约.md` §3.8）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `result_json.scene` | string | 场景：地点与空间元素（必填） |
| `result_json.lighting` | string | 光线：方向、性质、色温（必填） |
| `result_json.era` | string | 年代：可判断的时期与影像特征（必填） |
| `result_json.wardrobe` | string | 服饰：人物服装、发型与配饰（必填） |
| `result_json.composition` | string | 构图：机位、视角、景深层次（必填） |
| `result_prompt` | string | 自然语言提示词，可直接采纳的完整描述 |
| `suggest_era_code` | string \| null | 推荐年代代号，取值 `E1`–`E4`；无法判断时为 `null` |
| `suggest_scene_id` | INTEGER \| null | 推荐的场景 id，取值指向 `scenes.id`（即 `docs/prd/spec/era-scene-seed.json` 里 S1–S5 记录在 `scenes` 表中的主键）；无法判断时为 `null` |

约束：

1. `result_json` 五个键必须全部出现且非空；其中 `composition` / `wardrobe` 与 `spec/era-scene-seed.json` 中 `styleJson` 的同名字段对齐，便于用户把反推结果直接对上年代包与场景包；
2. `suggest_era_code` / `suggest_scene_id` 只是**推荐**，采纳与否由前端决定；采纳后仍走 §2 的 `buildPrompt` 拼装，反推结果**不得绕过**拼装函数，也**不得**直接用于生图（生图必须使用已确认的锚点）；
3. 反推任务**不产生** `identity_anchors` 行；读图失败、超时或输出不是合法 JSON 时按 `REV-01`–`REV-03` 处理（归属 `modules/M09-图片反推提示词.md`，见 `spec/07-验收标准.md`）。
