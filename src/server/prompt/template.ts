/**
 * `tpl-v1` 的段落标签与正文常量（`docs/prd/spec/05-Prompt工程.md` §2）。
 *
 * **本文件是 prompt 正文的唯一事实源**（`docs/prd/spec/05-Prompt工程.md` §1 铁律：业务代码不得内联
 * 第二份 prompt 文本）。改动这里属于「改 prompt 资产」：必须递增 `PROMPT_TEMPLATE_VERSION`
 * （`docs/prd/spec/05-Prompt工程.md` §7.2），并同步 `docs/prd/spec/05-Prompt工程.md` §2 的结构示意块——
 * 两者的逐字符等值由 `PR-10` 断言（实现见 `build.test.ts`）。
 */

/** 模板版本，写入 `generations.template_version`（`docs/prd/spec/05-Prompt工程.md` §7.1）。 */
export const PROMPT_TEMPLATE_VERSION = 'tpl-v1';

/** 七个段落标签常量；顺序即 `buildPrompt` 的固定段落顺序（`docs/prd/spec/05-Prompt工程.md` §2.1）。 */
export const SECTION_IDENTITY = '【身份锚点】';
export const SECTION_AGE = '【年龄保真】';
export const SECTION_ERA = '【年代】';
export const SECTION_SCENE = '【场景】';
export const SECTION_REALISM = '【质感】';
export const SECTION_ERA_FIT = '【年代一致】';
export const SECTION_PROFILE = '【组合微调】';

/** 【身份锚点】段的引导句（段首，后接 `identity_anchors.anchor_text` 原文）。 */
export const IDENTITY_LEAD = '严格保持参考图中人物的面部特征与身份一致，不同场景之间必须是同一个人：';

/**
 * 【年龄保真】段正文。防美化三处落点之二，**不可删除、无开关**
 * （`docs/prd/spec/05-Prompt工程.md` §4）；与 `docs/prd/spec/era-scene-seed.json` 顶层 `agePreserveClause`
 * 逐字符一致（`PR-10`）。
 */
export const AGE_PRESERVE_CLAUSE =
  '严格保留人物的真实年龄特征：保持源照片中已有的深皱纹、法令纹、眼角纹、老年斑与皮肤松弛，不做任何美化、磨皮与减龄处理；面部结构、脸型与体型比例不做任何修饰。';

/**
 * 【质感】段正文（写实锚定词）；与 `docs/prd/spec/era-scene-seed.json` 顶层 `realismAnchor` 逐字符一致
 * （`PR-10`）。不含「胶片」字样，避免与 E3 / E4 的年代包冲突（`docs/prd/spec/05-Prompt工程.md` §5）。
 */
export const REALISM_ANCHOR =
  '真实照片，随手拍的生活照，自然皮肤纹理，可见毛孔与细纹，真实肤色不均，柔和的对比度，构图自然不刻意';
