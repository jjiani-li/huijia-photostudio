import { createHash } from 'node:crypto';
import type { EraRecord, EraSceneProfileRecord, SceneRecord } from '../db/repositories/config';
import {
  AGE_PRESERVE_CLAUSE,
  IDENTITY_LEAD,
  PROMPT_TEMPLATE_VERSION,
  REALISM_ANCHOR,
  SECTION_AGE,
  SECTION_ERA,
  SECTION_ERA_FIT,
  SECTION_IDENTITY,
  SECTION_PROFILE,
  SECTION_REALISM,
  SECTION_SCENE,
} from './template';

/**
 * `buildPrompt` —— prompt 拼装的**唯一入口**（`docs/prd/spec/05-Prompt工程.md` §2、§2.2；
 * `docs/prd/modules/M05-年代场景配置与Prompt拼装.md` §5.1）。
 *
 * **纯函数**：不读库 / 读文件 / 读环境变量，函数体内不出现 `Date` 与 `Math.random`——
 * `PR-08` 要求同一组合连续两次拼装得到完全一致的文本与 `prompt_hash`。段落正文全部来自
 * `src/server/prompt/template.ts`（唯一事实源），本文件不内联任何 prompt 文本。
 */

export interface BuildPromptInput {
  anchorText: string;
  era: EraRecord;
  scene: SceneRecord;
  profile: EraSceneProfileRecord | null;
}

export interface BuildPromptResult {
  prompt: string;
  promptHash: string;
  templateVersion: string;
}

/**
 * 长度区间（`docs/prd/spec/07-验收标准.md` §2 的 `PR-07` 是**唯一阈值声明**，本处只是它的代码镜像）。
 * 越界只在日志里 `warn`，**不 throw、不改写文本、不截断**（截断会破坏 `PR-08` 的确定性）。
 */
export const PROMPT_MIN_LENGTH = 200;
export const PROMPT_MAX_LENGTH = 1200;

/**
 * 结构化 `warn`（`docs/prd/modules/M05-年代场景配置与Prompt拼装.md` §5.1）：只写一行 JSON，不阻断。
 * 不带时间戳——`buildPrompt` 的输出必须确定，日志不参与拼装结果。
 */
const warnLength = (eraCode: string, sceneId: number, length: number): void => {
  console.warn(
    JSON.stringify({
      level: 'warn',
      scope: 'server',
      job: 'generate',
      msg: 'prompt length out of range',
      era: eraCode,
      sceneId,
      length,
    }),
  );
};

export const buildPrompt = (input: BuildPromptInput): BuildPromptResult => {
  // 段落顺序固定、不得排序、不得条件重排（前六段无条件输出）。
  const sections: string[] = [
    SECTION_IDENTITY + IDENTITY_LEAD + input.anchorText,
    SECTION_AGE + AGE_PRESERVE_CLAUSE,
    SECTION_ERA + input.era.promptPack,
    SECTION_SCENE + input.scene.spacePack,
    SECTION_REALISM + REALISM_ANCHOR,
    SECTION_ERA_FIT + input.era.constraintPack,
  ];
  // `prompt_override` 为 `null` 或全空白时整段省略（尾部不留多余换行）。
  const override = input.profile?.promptOverride ?? null;
  if (override !== null && override.trim() !== '') sections.push(SECTION_PROFILE + override);

  const prompt = sections.join('\n');
  const length = prompt.length;
  if (length < PROMPT_MIN_LENGTH || length > PROMPT_MAX_LENGTH) {
    warnLength(input.era.code, input.scene.id, length);
  }
  return {
    prompt,
    promptHash: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    templateVersion: PROMPT_TEMPLATE_VERSION,
  };
};
