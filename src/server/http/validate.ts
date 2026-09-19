import { z } from 'zod';
import { AppError, ERROR_MESSAGE, ERROR_STATUS } from '../domain/errors';

/** zod 的字段错误展开为 `details.fields`（`docs/prd/spec/03-接口契约.md` §1.3：前端只依赖这一个 details 形状）。 */
export const zodFields = (err: z.ZodError): Record<string, string[]> => {
  const fields: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
};

export const invalidParam = (err: z.ZodError): AppError =>
  new AppError('INVALID_PARAM', ERROR_MESSAGE.INVALID_PARAM, ERROR_STATUS.INVALID_PARAM, {
    fields: zodFields(err),
  });

/** 参数校验：失败一律 `INVALID_PARAM`（含 `details.fields`），不把 zod 的原始错误抛给调用方。 */
export const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw invalidParam(result.error);
  return result.data;
};

/** 读 JSON 请求体并校验；请求体不是合法 JSON 也算 `INVALID_PARAM`。 */
export const parseJson = async <T>(req: Request, schema: z.ZodType<T>): Promise<T> => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError('INVALID_PARAM', ERROR_MESSAGE.INVALID_PARAM, ERROR_STATUS.INVALID_PARAM, {
      fields: { _: ['请求体不是合法 JSON'] },
    });
  }
  return parse(schema, body);
};

/** 路径段 / 查询参数里的正整数（如 `:id`）；不是正整数 → `INVALID_PARAM`。 */
export const parsePositiveInt = (raw: string, field: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError('INVALID_PARAM', ERROR_MESSAGE.INVALID_PARAM, ERROR_STATUS.INVALID_PARAM, {
      fields: { [field]: ['必须是正整数'] },
    });
  }
  return value;
};
