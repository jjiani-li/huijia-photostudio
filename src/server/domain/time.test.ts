import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayKey, nowIso } from './time';

describe('time', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('nowIso 是毫秒精度的 UTC ISO-8601，Z 结尾', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T15:07:42.123Z'));

    expect(nowIso()).toBe('2026-09-17T15:07:42.123Z');
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('dayKey 取 UTC 日期，跨本地时区不偏移', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T23:59:59.999Z'));
    expect(dayKey()).toBe('2026-09-17');

    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    expect(dayKey()).toBe('2026-09-18');
  });
});
