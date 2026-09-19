import { randomUUID } from 'node:crypto';
import { LocalStorageProvider } from './local';
import type { ImageExt, StorageKey, StorageProvider } from './types';

/**
 * 存储层的唯一入口（`docs/prd/modules/M01-照片资产与存储.md` §4.1）：
 * `getStorage()` 进程内单例（当前恒为 `LocalStorageProvider`）、`buildKey()` 唯一的 key 生成入口
 * （`spec/04-技术基线与目录结构.md` §4.5）。
 */
export * from './types';

let instance: StorageProvider | null = null;

export const getStorage = (): StorageProvider => {
  if (instance === null) instance = new LocalStorageProvider();
  return instance;
};

/** 测试用：清空单例，使下次 `getStorage()` 按当前 `STORAGE_DIR` 重建。 */
export const resetStorage = (): void => {
  instance = null;
};

/** `u${userId}/${randomUUID()}.${ext}`（`spec/04` §4.5）。 */
export const buildKey = (userId: number, ext: ImageExt): StorageKey =>
  `u${userId}/${randomUUID()}.${ext}`;
