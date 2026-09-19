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
      'components/**/*.test.tsx',
    ],
  },
});
