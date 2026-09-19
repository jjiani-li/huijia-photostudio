import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `.tsx` 组件测试：esbuild 用自动 JSX 运行时（tsconfig 的 `jsx: preserve` 是给 Next 用的）。
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'app/**/*.test.{ts,tsx}',
      'hooks/**/*.test.ts',
      // `components/` 下既有 `.tsx` 组件、也有纯逻辑 `.ts` 模块（如 `choose/selection.ts`）。
      'components/**/*.test.{ts,tsx}',
    ],
  },
});
