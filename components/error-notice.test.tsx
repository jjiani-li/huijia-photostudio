import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { ERROR_CODES } from '../src/shared/types';
import { ErrorNotice, errorShape } from './error-notice';

/** `next/link` 在 node 环境（非 App Router 运行时）不挂载 router，测试里换成普通 `<a>`。 */
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

/**
 * `ErrorNotice`（`docs/prd/pages/P00-设计基准与路由.md` §8、§12）：
 * 全错误码可渲染、主文案取服务端 `message`、未知 `code` 走 `INTERNAL`、`UNAUTHENTICATED` 为 page + 「去登录」。
 */
describe('ErrorNotice', () => {
  it('全部错误码可渲染，主文案直接用服务端 message', () => {
    for (const code of ERROR_CODES) {
      const html = renderToStaticMarkup(<ErrorNotice error={{ code, message: `服务端文案-${code}` }} />);
      expect(html).toContain(`服务端文案-${code}`);
    }
  });

  it('未知 code → 按 INTERNAL 的形态，仍显示服务端 message', () => {
    expect(errorShape('NOT_A_REAL_CODE')).toEqual(errorShape('INTERNAL'));
    const html = renderToStaticMarkup(<ErrorNotice error={{ code: 'NOT_A_REAL_CODE', message: '兜底' }} />);
    expect(html).toContain('兜底');
  });

  it('UNAUTHENTICATED → page 形态 + 「去登录」→ /login', () => {
    expect(errorShape('UNAUTHENTICATED')).toEqual({ variant: 'page', retryable: false });
    const html = renderToStaticMarkup(<ErrorNotice error={{ code: 'UNAUTHENTICATED', message: '请先登录' }} />);
    expect(html).toContain('去登录');
    expect(html).toContain('/login');
  });

  it('NOT_FOUND 系 → page + 「回历史」→ /history', () => {
    const html = renderToStaticMarkup(<ErrorNotice error={{ code: 'ANCHOR_NOT_FOUND', message: 'm' }} />);
    expect(html).toContain('回历史');
    expect(html).toContain('/history');
  });

  it('可重试码 + 传 onRetry → 有「重试」按钮；不传则无', () => {
    const withRetry = renderToStaticMarkup(
      <ErrorNotice error={{ code: 'PROVIDER_ERROR', message: 'm' }} onRetry={() => undefined} />,
    );
    expect(withRetry).toContain('重试');
    const withoutRetry = renderToStaticMarkup(<ErrorNotice error={{ code: 'PROVIDER_ERROR', message: 'm' }} />);
    expect(withoutRetry).not.toContain('重试');
  });

  it('error 为 null → 不渲染', () => {
    expect(renderToStaticMarkup(<ErrorNotice error={null} />)).toBe('');
  });
});
