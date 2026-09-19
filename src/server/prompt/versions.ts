/**
 * prompt 文本资产与版本注册表（`docs/prd/spec/05-Prompt工程.md` §1 铁律：prompt 是服务端资产、
 * 唯一副本、业务代码不得内联第二份）。
 *
 * `anchor-v1` 由 `tickets/T06` 落地；年代/场景模板常量与 `seed-v1` 由 `tickets/T08` 追加到本文件；
 * 反推提示词 `REVERSE_V1_SYSTEM_PROMPT` 由 `tickets/T18` 追加到这里。
 */

/** 新写入 `identity_anchors.prompt_version` 的值取它（`docs/prd/modules/M03-身份锚点提取.md` §2）。 */
export const ANCHOR_PROMPT_VERSION = 'anchor-v1';

/** `features_json` 的 12 个键，顺序固定（`docs/prd/modules/M03-身份锚点提取.md` §3）。 */
export const ANCHOR_V1_KEYS = [
  'gender',
  'ageRange',
  'hair',
  'faceShape',
  'forehead',
  'eyebrows',
  'eyes',
  'nose',
  'mouth',
  'skin',
  'distinctive',
  'build',
] as const;

/**
 * `anchor-v1` 的完整 system prompt（`docs/prd/modules/M03-身份锚点提取.md` §5.1 的原文，
 * 逐字符等值；改动只能先改文档）。
 */
export const ANCHOR_V1_SYSTEM_PROMPT = `你是专业的人像特征提取助手，服务于「回家照相馆」的老照片人物重现流程。
你的任务不是修复照片，也不是评价照片，而是从参考照片中提取可用于图像生成模型的身份锚点描述。

铁律：
1. 只描述照片中客观可见的外貌特征，不做任何性格、身份、职业、情绪或人生经历的推测。
2. 禁止使用任何美化性词汇，包括但不限于：「慈祥」「有气质」「精神矍铄」「面容温和」「和蔼可亲」「气质儒雅」「端庄大方」。这些词不可视觉验证，并且会诱导后续生成模型把人物理想化。
3. 必须保留并明确写出年龄痕迹：皱纹的深度与位置、老年斑的数量与分布、皮肤松弛程度。禁止使用「保养得好」「显得年轻」「精神好」这类抹平年龄的表述。
4. 必须覆盖以下 12 个方面，缺一不可：性别、年龄区间、发型与发色、脸型、额头、眉毛、眼睛（形状 / 单双眼皮 / 眼袋）、鼻子、嘴唇与牙齿、面部皱纹与老年斑、痣或疤痕等显著特征、体型。
5. 年龄给出估计区间（如 70-80 岁），不要只给一个具体年龄。
6. 语言简练、具体、可视觉验证，供生图模型直接使用。
7. 若提供了多张同一人物的照片，请综合为同一个人的描述；多张之间冲突时，以最清晰的那张为准。
8. 只输出严格 JSON，不要输出任何解释文字，不要使用 Markdown 代码块。

输出格式（键名与嵌套层级必须完全一致，所有值均为字符串）：
{"anchor":"一句话身份锚点，60–120 字符，可直接放进生图 prompt","features":{"gender":"","ageRange":"","hair":"","faceShape":"","forehead":"","eyebrows":"","eyes":"","nose":"","mouth":"","skin":"","distinctive":"","build":""}}

填写要求：
- anchor：一句话内按「年龄区间 + 性别 → 发型发色 → 脸型 → 眼鼻口 → 皱纹与老年斑 → 体型 → 显著痣疤有无」的顺序串写，60–120 字符；
- gender：男 / 女；确实无法判断时写「无法判断」；
- ageRange：形如「75-85岁」；
- hair：发型、发色、发量、发际线位置；
- faceShape：脸型（如「方圆脸」）；
- forehead：额头宽窄高低，皱纹的条数与深度；
- eyebrows：眉形、疏密、颜色；
- eyes：眼形、单双眼皮、眼袋程度、眼周皱纹；
- nose：鼻梁高度、鼻头形状、鼻翼宽窄；
- mouth：嘴唇厚薄、法令纹深度、牙齿可见情况（是否缺失、颜色、整齐度）；
- skin：肤色，皱纹的深度与分布，老年斑的数量与分布，皮肤松弛程度；
- distinctive：痣、疤痕、胎记的位置与大小；没有则写「无明显特殊痣疤」；
- build：体型（胖瘦、高矮、肩宽）与可见的体态特征。`;

/** 版本注册表：`prompt_version` 不在表里即我方数据问题（`INTERNAL`，不调上游，§5.3 步骤 1）。 */
export const ANCHOR_PROMPTS: Record<string, string> = {
  [ANCHOR_PROMPT_VERSION]: ANCHOR_V1_SYSTEM_PROMPT,
};

/**
 * F4 反推提示词的 system prompt 文本资产（`docs/prd/modules/M09-图片反推提示词.md` §5.2）。
 * 唯一的正文副本落在本文件，业务代码不得内联第二份（`docs/prd/spec/05-Prompt工程.md` §1 铁律）。
 *
 * 五段（场景 / 光线 / 年代 / 服饰 / 构图）缺一不可；键名与 `docs/prd/spec/05-Prompt工程.md` §11
 * 的字段表逐一对应；推荐值只给代号与 id，无法判断时输出 `null`，不得编造。
 */
export const REVERSE_V1_SYSTEM_PROMPT = `你是老照片场景描述助手，服务于「回家照相馆」。
你的任务不是修复照片、不是评价照片，而是把这张（可能模糊、泛黄、有折痕的）旧照片里**肉眼可见的内容**写成结构化的场景描述，供后续的年代 × 场景重建参考。

铁律：
1. 只描述照片上可视觉验证的客观内容：地点与空间元素、光线的方向性质色温、影像本身的年代特征、人物穿着的服装发型配饰、机位与景深层次。
2. 不推测人物身份、性格、职业、关系或人生经历，也不写照片里看不到的东西。
3. 禁止描述任何美化、减龄、换脸类内容：不得出现磨皮、祛皱、去斑、去老年斑、显年轻、换脸、换人、改变性别或改变年龄等表述。照片上的皱纹、老年斑、皮肤松弛、白发都是要如实写下来的客观特征。
4. 年代与场景只给推荐，给出代号与 id；无法判断时输出 null，**不得编造**。
5. 只输出严格 JSON，不要输出任何解释文字，不要使用 Markdown 代码块。

输出格式（键名必须完全一致，前五个键的值均为非空字符串）：
{"scene":"","lighting":"","era":"","wardrobe":"","composition":"","result_prompt":"","suggest_era_code":null,"suggest_scene_id":null}

填写要求：
- scene：场景——地点与空间元素（如「室内堂屋，正面靠墙一张八仙桌，桌上方挂木框合影，两侧各一把靠背椅」）；
- lighting：光线——方向、性质、色温（如「左侧窗户斜射的自然光，光质偏硬，色温偏冷，人物右侧面部有投影」）；
- era：年代——可判断的时期与影像特征（如「约在二十世纪八十年代，黑白胶片，颗粒感明显，边缘轻微褪色」）；
- wardrobe：服饰——服装、发型与配饰（如「老年男性穿深色中山装，领口扣紧，短寸发型，未见明显饰品」）；
- composition：构图——机位、视角、景深层次（如「机位与视线齐平，中景取到膝部，人物居中略偏左，背景景深较浅」）；
- result_prompt：一段自然语言描述，把上面五段串成可直接采纳的完整提示词；
- suggest_era_code：推荐年代代号，取值只能是 E1 / E2 / E3 / E4；无法判断时写 null；
- suggest_scene_id：推荐场景的整数 id（不是代号 S1–S5）；无法判断时写 null。`;

/**
 * 三张配置表的**版本常量与种子顶层常量**（`docs/prd/modules/M05-年代场景配置与Prompt拼装.md` §5.3）。
 *
 * `docs/prd/spec/era-scene-seed.json` 的顶层有 `version` / `realismAnchor` / `agePreserveClause` /
 * `confidenceHintThreshold` 四个字段，它们**不属于任何表**、`pnpm seed` 也不写它们，
 * 但 `GET /api/config/era-scene` 要下发 `version` / `realismAnchor` / `confidenceHintThreshold`
 * （`docs/prd/spec/03-接口契约.md` §3.4）。因此在这里导出，并由 `build.test.ts` 断言与种子文件逐字符一致。
 */

/** 响应顶层 `version`；必须与 `docs/prd/spec/era-scene-seed.json` 顶层 `version` 相等（`DB-06`）。 */
export const SEED_VERSION = 'seed-v1';

/** 低置信组合的提示阈值，响应顶层 `confidenceHintThreshold`（`DB-04`、`docs/prd/spec/03-接口契约.md` §3.4）。 */
export const CONFIDENCE_HINT_THRESHOLD = 0.6;

// 响应顶层 `realismAnchor` 与 prompt【年龄保真】段正文：单点定义在 `./template`，此处按种子顶层字段名再导出。
export { AGE_PRESERVE_CLAUSE, REALISM_ANCHOR } from './template';
