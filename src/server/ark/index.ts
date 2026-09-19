import { MockArkProvider } from './mock';
import { RealArkProvider } from './real';
import type { ArkProvider } from './types';

/**
 * `getArk()`：按 `PROVIDER` 返回进程内单例（`docs/prd/spec/08-本地开发指南.md` §5）。
 * 业务代码只依赖 `ArkProvider` 接口，不得直接 `fetch`。
 */
let instance: ArkProvider | null = null;

export const getArk = (): ArkProvider => {
  if (instance === null) {
    instance = process.env.PROVIDER === 'real' ? new RealArkProvider() : new MockArkProvider();
  }
  return instance;
};

/** 测试用：清空单例。 */
export const resetArk = (): void => {
  instance = null;
};

export * from './types';
export * from './errors';
export { arkVisionModel, arkImageModel } from './real';
