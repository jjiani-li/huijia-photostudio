import { z } from 'zod';

/**
 * JSON 列（`*_json` / `TEXT`）的统一边界校验（`docs/prd/spec/04-技术基线与目录结构.md` §4.3）：
 * 读取后立即 `JSON.parse` 并经 zod 校验；**不返回数据库原始行**。
 * 校验失败抛普通 `Error`（→ `withErrorHandling` 归 `INTERNAL`），不把损坏的库内容当成用户参数错误。
 */
export const parseJsonColumn = <T>(
  raw: string | null,
  schema: z.ZodType<T>,
  column: string,
): T | null => {
  if (raw === null) return null;
  const result = schema.safeParse(JSON.parse(raw));
  if (!result.success) throw new Error(`${column} 的 JSON 内容不合法：${result.error.message}`);
  return result.data;
};

/** 非空 JSON 列（`NOT NULL`）的读取入口。 */
export const parseRequiredJsonColumn = <T>(
  raw: string,
  schema: z.ZodType<T>,
  column: string,
): T => {
  const parsed = parseJsonColumn(raw, schema, column);
  if (parsed === null) throw new Error(`${column} 不应为 null`);
  return parsed;
};

/** object 型 JSON 列：`style_json` / `quality_json` / `params_json` / `features_json` / `meta_json` / `result_json`。 */
export const objectJson = z.record(z.string(), z.unknown());

/** 整数 id 数组型 JSON 列：`input_photo_ids` / `reference_photo_ids`。 */
export const idArrayJson = z.array(z.number().int());
