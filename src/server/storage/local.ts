import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { appError } from '../domain/errors';
import { nowIso } from '../domain/time';
import type { SaveResult, StorageKey, StorageProvider, StoredStat } from './types';

/**
 * `LocalStorageProvider`（`docs/prd/modules/M01-照片资产与存储.md` §4.2）。
 * 原子写、path traversal 防护、分片目录、`STORAGE_ERROR` 映射。
 */
const SAFE_KEY_RE = /^u[1-9]\d*\/[A-Za-z0-9._-]+$/;

export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root = process.env.STORAGE_DIR ?? './storage') {
    this.root = path.resolve(root);
  }

  /** 每个方法入口第一行调用；拒绝 traversal / 盘符 / ADS / 绝对路径。 */
  private assertSafeKey(key: StorageKey): void {
    if (
      !SAFE_KEY_RE.test(key) ||
      key.includes('..') ||
      key.includes('\\') ||
      key.includes(':') ||
      key.startsWith('/') ||
      path.isAbsolute(key)
    ) {
      throw appError('STORAGE_ERROR', { key, reason: 'unsafe storage key' });
    }
  }

  resolveAbs(key: StorageKey): string {
    this.assertSafeKey(key);
    const abs = path.resolve(this.root, key);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw appError('STORAGE_ERROR', { key, reason: 'resolved outside storage root' });
    }
    return abs;
  }

  async save(key: StorageKey, data: Buffer): Promise<SaveResult> {
    const abs = this.resolveAbs(key);
    const tmp = `${abs}.${randomUUID()}.tmp`;
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    try {
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, abs);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw mapIoError(err, key);
    }
    const stats = await fsp.stat(abs);
    return { key, bytes: stats.size };
  }

  async read(key: StorageKey): Promise<Buffer> {
    const abs = this.resolveAbs(key);
    try {
      return await fsp.readFile(abs);
    } catch (err) {
      throw mapIoError(err, key);
    }
  }

  async delete(key: StorageKey): Promise<boolean> {
    const abs = this.resolveAbs(key);
    try {
      await fsp.unlink(abs);
      return true;
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return false;
      throw mapIoError(err, key);
    }
  }

  async exists(key: StorageKey): Promise<boolean> {
    const abs = this.resolveAbs(key);
    try {
      await fsp.access(abs, fs.constants.F_OK);
      return true;
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return false;
      throw mapIoError(err, key);
    }
  }

  async stat(key: StorageKey): Promise<StoredStat | null> {
    const abs = this.resolveAbs(key);
    try {
      const stats = await fsp.stat(abs);
      if (!stats.isFile()) return null;
      return { key, bytes: stats.size, modifiedAt: new Date(stats.mtimeMs).toISOString() };
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return null;
      throw mapIoError(err, key);
    }
  }
}

const errnoOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined;

const isErrno = (err: unknown, code: string): boolean => errnoOf(err) === code;

/** `ENOENT` → `404 NOT_FOUND`；其余 → `500 STORAGE_ERROR`（文案取 `spec/03-接口契约.md` §5；原始 errno 只进 details 便于排查）。 */
const mapIoError = (err: unknown, key: string): Error => {
  const errno = errnoOf(err);
  if (errno === 'ENOENT') return appError('NOT_FOUND', { key });
  return appError('STORAGE_ERROR', { key, errno, at: nowIso() });
};
