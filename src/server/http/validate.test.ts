import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../domain/errors';
import { parse, parseJson } from './validate';

const schema = z.object({ count: z.number().int().min(2).max(4), consent: z.literal(true) });

describe('validate', () => {
  it('合法输入原样通过', () => {
    expect(parse(schema, { count: 2, consent: true })).toEqual({ count: 2, consent: true });
  });

  it('非法输入 → INVALID_PARAM，details.fields 按字段名归组', () => {
    try {
      parse(schema, { count: 1, consent: false });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const err = error as AppError;
      expect(err.code).toBe('INVALID_PARAM');
      expect(err.status).toBe(400);
      expect(Object.keys((err.details as { fields: object }).fields).sort()).toEqual(['consent', 'count']);
    }
  });

  it('缺失字段也归到对应字段名下', () => {
    const err = (() => {
      try {
        parse(z.object({ eraCode: z.string() }), {});
      } catch (e) {
        return e as AppError;
      }
      return null;
    })();
    expect((err?.details as { fields: Record<string, string[]> }).fields.eraCode).toBeTruthy();
  });

  it('parseJson 读请求体并校验', async () => {
    const req = new Request('http://localhost/api/probe', {
      method: 'POST',
      body: JSON.stringify({ count: 3, consent: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(await parseJson(req, schema)).toEqual({ count: 3, consent: true });
  });

  it('parseJson 对非 JSON 请求体 → INVALID_PARAM，而不是抛原始 SyntaxError', async () => {
    const req = new Request('http://localhost/api/probe', { method: 'POST', body: 'not json' });
    await expect(parseJson(req, schema)).rejects.toMatchObject({ code: 'INVALID_PARAM', status: 400 });
  });
});
