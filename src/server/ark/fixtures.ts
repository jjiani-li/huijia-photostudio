import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArkErrorShape, ArkFailureKind } from './errors';

/**
 * fixture 读取与回放选择（`docs/prd/spec/08-本地开发指南.md` §5.1）。
 * `fixtures/ark/*.json` 与 `fixtures/images/*` 是 mock 的本地替身数据。
 */
const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures', import.meta.url));

const fixturePath = (rel: string): string => path.join(FIXTURES_DIR, rel);

export const readFixture = <T>(rel: string): T =>
  JSON.parse(fs.readFileSync(fixturePath(rel), 'utf8')) as T;

/** 冻结在 `spec/08` §5.1 的三个失败分支文件名。 */
export type MockFailureId = 'invalid-size' | 'model-not-open' | 'timeout';

interface FailureFixture {
  kind: ArkFailureKind;
  status?: number;
  message?: string;
  error?: { code?: string; message?: string };
}

export const readFailureFixture = (id: MockFailureId): ArkErrorShape => {
  const fixture = readFixture<FailureFixture>(`ark/${id}.json`);
  return {
    kind: fixture.kind,
    errorCode: fixture.error?.code,
    httpStatus: fixture.status,
    message: fixture.error?.message ?? fixture.message,
  };
};

// ── 复核 / 审核回放（`docs/prd/modules/M07-生成后复核与内容审核.md` §7.1–§7.2）：读取与确定性选择 ──

export interface EraCheckCase {
  id: string;
  /** `eraCode` 与 `sceneId` 同时相等才命中；`null` 表示只在 `switch.activeCaseId` 下使用。 */
  match: { eraCode: string; sceneId: number } | null;
  verdict: string;
  findings: Array<{ item: string; reason: string }>;
  estimatedAgeRange: string | null;
}

export interface EraCheckFixture {
  version: string;
  promptVersion: string;
  model: string;
  switch: { activeCaseId: string | null };
  defaultCaseId: string;
  cases: EraCheckCase[];
}

export interface SafetyVariant {
  id: string;
  verdict: string;
  reason: string | null;
}

export interface SafetyReviewFixture {
  version: string;
  model: string;
  defaultVariantId: string;
  switchVariants: Record<'upload' | 'prompt' | 'result', string | null>;
  variants: SafetyVariant[];
}

export const readEraCheckFixture = (): EraCheckFixture => readFixture<EraCheckFixture>('ark/era-check.json');

export const readSafetyReviewFixture = (): SafetyReviewFixture =>
  readFixture<SafetyReviewFixture>('ark/safety-review.json');

/**
 * 复核 case 的确定性选择（`modules/M07` §7.1）：① `switch.activeCaseId` 非空直接用；
 * ② 否则按 `match` 逐条匹配（`eraCode` 与 `sceneId` 同时相等），取第一条命中；③ 都不命中 → `defaultCaseId`。
 */
export const selectEraCheckCase = (
  fixture: EraCheckFixture,
  ctx: { eraCode: string; sceneId: number },
): EraCheckCase | undefined => {
  const active = fixture.switch.activeCaseId;
  return (
    (active === null ? undefined : fixture.cases.find((item) => item.id === active)) ??
    fixture.cases.find(
      (item) => item.match !== null && item.match.eraCode === ctx.eraCode && item.match.sceneId === ctx.sceneId,
    ) ??
    fixture.cases.find((item) => item.id === fixture.defaultCaseId) ??
    fixture.cases[0]
  );
};

/**
 * 审核 variant 的确定性选择（`modules/M07` §7.2）：`switchVariants[stage]` 优先于 `defaultVariantId`；
 * **按阶段分别开闸**，才能单独测 result 阶段的判定。
 */
export const selectSafetyVariant = (
  fixture: SafetyReviewFixture,
  stage: 'upload' | 'prompt' | 'result',
): SafetyVariant | undefined => {
  const variantId = fixture.switchVariants[stage] ?? fixture.defaultVariantId;
  return (
    fixture.variants.find((item) => item.id === variantId) ??
    fixture.variants.find((item) => item.id === fixture.defaultVariantId)
  );
};
