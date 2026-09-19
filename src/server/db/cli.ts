import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 脚本入口判定：`tsx src/server/db/<name>.ts` 直接执行时为真，
 * 被 `reset.ts` / 测试 import 时为假（避免副作用）。
 */
export const isMain = (metaUrl: string): boolean => {
  const entry = process.argv[1];
  return entry != null && path.resolve(entry) === fileURLToPath(metaUrl);
};
