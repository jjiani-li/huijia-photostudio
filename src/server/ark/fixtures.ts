import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArkErrorShape, ArkFailureKind } from './errors';

/**
 * fixture 读取与回放选择（`docs/prd/spec/08-本地开发指南.md` §5.1）。
 * `fixtures/ark/*.json` 与 `fixtures/images/*` 是 mock 的本地替身数据。
 */
const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures', import.meta.url));

export const fixturePath = (rel: string): string => path.join(FIXTURES_DIR, rel);

export const readFixture = <T>(rel: string): T =>
  JSON.parse(fs.readFileSync(fixturePath(rel), 'utf8')) as T;

/** 冻结在 `spec/08` §5.1 的三个失败分支文件名。 */
export type MockFailureId = 'invalid-size' | 'model-not-open' | 'timeout';
export const MOCK_FAILURE_IDS: MockFailureId[] = ['invalid-size', 'model-not-open', 'timeout'];

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
