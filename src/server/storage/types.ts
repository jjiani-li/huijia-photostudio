import type { Iso } from '../../shared/types';

/**
 * `StorageProvider` 抽象（`docs/prd/modules/M01-照片资产与存储.md` §4.1）。
 * 本期只有一个实现 `LocalStorageProvider`；照片以文件存在本地目录，`photos.storage_key` 存相对路径。
 */
export type StorageKey = string; // 形如 'u12/3f9a2c1e-....jpg'，相对存储根
export type ImageExt = 'jpg' | 'png' | 'webp' | 'heic';

export interface SaveResult {
  key: StorageKey;
  bytes: number;
}

export interface StoredStat {
  key: StorageKey;
  bytes: number;
  modifiedAt: Iso;
}

/** 错误语义：key 缺失 → `AppError(NOT_FOUND)`；其他 IO 错误 → `AppError(STORAGE_ERROR)`。 */
export interface StorageProvider {
  /** 原子写：写同目录 `<key>.<uuid>.tmp` → rename。 */
  save(key: StorageKey, data: Buffer): Promise<SaveResult>;
  read(key: StorageKey): Promise<Buffer>;
  /** 不存在返回 `false`（幂等），不抛错。 */
  delete(key: StorageKey): Promise<boolean>;
  exists(key: StorageKey): Promise<boolean>;
  /** 不存在返回 `null`，不抛错。 */
  stat(key: StorageKey): Promise<StoredStat | null>;
  /** 相对 key → 绝对路径；纯函数换算，不触盘。 */
  resolveAbs(key: StorageKey): string;
}
