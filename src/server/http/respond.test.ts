import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError, ERROR_MESSAGE } from '../domain/errors';
import { ok, withErrorHandling } from './respond';

const call = (handler: Parameters<typeof withErrorHandling>[0]) =>
  withErrorHandling(handler)(new NextRequest('http://localhost/api/probe', { method: 'POST' }), {
    params: Promise.resolve({}),
  });

describe('respond', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ok 直接返回业务对象，不用 envelope', async () => {
    const res = await call(async () => ok({ photo: { id: 'p1' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ photo: { id: 'p1' } });
  });

  it('ok 可指定状态码', async () => {
    const res = await call(async () => ok({ id: 'a1' }, 202));
    expect(res.status).toBe(202);
  });

  it('AppError → 按其 status 返回统一 envelope', async () => {
    const res = await call(async () => {
      throw new AppError('QUOTA_EXCEEDED', ERROR_MESSAGE.QUOTA_EXCEEDED, 429, { day: '2026-09-17' });
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { code: 'QUOTA_EXCEEDED', message: ERROR_MESSAGE.QUOTA_EXCEEDED, details: { day: '2026-09-17' } },
    });
  });

  it('AppError 无 details 时 envelope 的 details 是空对象', async () => {
    const res = await call(async () => {
      throw new AppError('NOT_FOUND', ERROR_MESSAGE.NOT_FOUND, 404);
    });
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: ERROR_MESSAGE.NOT_FOUND, details: {} },
    });
  });

  it('裸 ZodError → 400 INVALID_PARAM，并带 details.fields', async () => {
    const schema = z.object({ count: z.number().int().min(2) });
    const res = await call(async () => {
      schema.parse({ count: 1 });
      return ok({});
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_PARAM');
    expect(Object.keys(body.error.details.fields)).toEqual(['count']);
  });

  it('未预期的异常 → 500 INTERNAL，且不透传原始 message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(async () => {
      throw new Error('disk /secret/path is on fire');
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toBe(ERROR_MESSAGE.INTERNAL);
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain('secret');
  });

  it('ctx.params 透传给 handler', async () => {
    const res = await withErrorHandling(async (_req, ctx: { params: Promise<{ id: string }> }) =>
      ok({ id: (await ctx.params).id }),
    )(new NextRequest('http://localhost/api/probe'), { params: Promise.resolve({ id: 'x9' }) });
    expect(await res.json()).toEqual({ id: 'x9' });
  });
});
