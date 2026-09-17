import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { AppError, ERROR_MESSAGE, ERROR_STATUS } from '../domain/errors';
import { nowIso } from '../domain/time';
import { invalidParam } from './validate';

/** 成功响应不用 envelope，直接返回业务对象（`docs/prd/spec/03-接口契约.md` §1.4）。 */
export const ok = <T>(data: T, status = 200) => NextResponse.json(data, { status });

const toErrorResponse = (error: AppError) =>
  NextResponse.json(
    { error: { code: error.code, message: error.message, details: error.details ?? {} } },
    { status: error.status },
  );

/** Next 15 的 route context；无动态段时 `params` 为空对象。 */
export type RouteContext<P = Record<string, string>> = { params: Promise<P> };

type RouteHandler<P> = (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> | Response;

/**
 * 统一响应包装器（`docs/prd/spec/04-技术基线与目录结构.md` §4.1、§4.4）。
 * 捕获顺序固定：`AppError` → 按其 `status`；`ZodError` → `INVALID_PARAM`；
 * 其他 → 结构化日志 + `INTERNAL`（**原始 message 不透给用户**）。
 */
export const withErrorHandling =
  <P>(handler: RouteHandler<P>) =>
  async (req: NextRequest, ctx: RouteContext<P>): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (error) {
      if (error instanceof AppError) return toErrorResponse(error);
      if (error instanceof ZodError) return toErrorResponse(invalidParam(error));
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'unhandled error',
          method: req.method,
          path: req.nextUrl?.pathname ?? null,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          at: nowIso(),
        }),
      );
      return NextResponse.json(
        { error: { code: 'INTERNAL', message: ERROR_MESSAGE.INTERNAL, details: {} } },
        { status: ERROR_STATUS.INTERNAL },
      );
    }
  };
