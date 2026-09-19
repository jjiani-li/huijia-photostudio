import { describe, expect, it } from 'vitest';
import config from '../tailwind.config';

/**
 * Token 契约测试（`docs/prd/pages/P00-设计基准与路由.md` §3.2、§3.3、§12）：防样式漂移。
 * 色值本身的正确性由本文件只查键表——色值字面量只允许出现在 `tailwind.config.ts`。
 */
const extend = (config.theme?.extend ?? {}) as Record<string, Record<string, unknown>>;

describe('tailwind.config.ts 的 Token 契约', () => {
  it('§3.2 的 9 个语义色（含 primary / ink 的 DEFAULT 与 soft）', () => {
    const colors = extend.colors ?? {};
    for (const key of ['background', 'surface', 'wood', 'primary', 'ink', 'border', 'danger']) {
      expect(colors).toHaveProperty(key);
    }
    expect(colors.primary).toMatchObject({ DEFAULT: expect.any(String), soft: expect.any(String) });
    expect(colors.ink).toMatchObject({ DEFAULT: expect.any(String), soft: expect.any(String) });
  });

  it('§3.3 的 6 档字号', () => {
    const fontSize = extend.fontSize ?? {};
    for (const key of ['display', 'title', 'heading', 'body', 'note', 'micro']) {
      expect(fontSize).toHaveProperty(key);
    }
  });

  it('§3.4 的间距 / maxWidth.content / 圆角 / 阴影 / 动效', () => {
    expect(extend.maxWidth ?? {}).toHaveProperty('content');
    for (const key of ['sm', 'md', 'lg', 'pill']) expect(extend.borderRadius ?? {}).toHaveProperty(key);
    for (const key of ['soft', 'card']) expect(extend.boxShadow ?? {}).toHaveProperty(key);
    expect(extend.animation ?? {}).toHaveProperty('fade-in');
    expect(extend.keyframes ?? {}).toHaveProperty('fadeIn');
    for (const key of ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl']) {
      expect(extend.spacing ?? {}).toHaveProperty(key);
    }
  });

  it('§4.1 字体栈：serif 与 sans 都指向系统字体（不含冷感几何无衬线）', () => {
    const fontFamily = (extend.fontFamily ?? {}) as Record<string, string[]>;
    expect(fontFamily.serif).toContain('serif');
    expect(fontFamily.sans).toContain('sans-serif');
  });
});
