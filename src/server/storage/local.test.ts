import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildKey, getStorage, resetStorage } from './index';
import { LocalStorageProvider } from './local';

/**
 * M01 §9 用例 1–3：`buildKey` / 原子写 / path traversal / `read` / `stat` / `delete`。
 */
let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'huijia-storage-'));
  process.env.STORAGE_DIR = root;
  resetStorage();
});

afterAll(() => {
  resetStorage();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.STORAGE_DIR;
});

const listFiles = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)],
      )
    : [];

describe('buildKey / save 原子性', () => {
  it('buildKey 形状正确、两次调用同目录不同文件名', async () => {
    expect(buildKey(12, 'jpg')).toMatch(/^u12\/[0-9a-f-]{36}\.jpg$/);
    const a = buildKey(12, 'jpg');
    const b = buildKey(12, 'jpg');
    expect(path.dirname(a)).toBe(path.dirname(b));
    expect(a).not.toBe(b);

    const data = Buffer.from('hello-photo');
    const storage = getStorage();
    const saved = await storage.save(a, data);
    expect(saved.bytes).toBe(data.byteLength);
    expect(fs.readFileSync(path.join(root, a)).byteLength).toBe(data.byteLength);
    // 目录里没有 .tmp 残留
    expect(listFiles(root).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

describe('path traversal', () => {
  it('非法 key 全部抛 STORAGE_ERROR，且根目录外无文件被创建', async () => {
    const storage = new LocalStorageProvider(root);
    const bad = ['../../etc/passwd', '/abs/path', 'u1/../u2/x.jpg', 'u1\\x.jpg', 'u1/C:\\x.jpg'];
    const before = listFiles(root).length;
    for (const key of bad) {
      await expect(storage.save(key, Buffer.from('x'))).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
      await expect(storage.read(key)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    }
    expect(listFiles(root).length).toBe(before); // 根目录内没有新文件
    expect(fs.existsSync(path.resolve(root, '..', '..', 'etc', 'passwd'))).toBe(false); // 根目录外也没有
  });
});

describe('read / stat / delete', () => {
  it('read 不存在的 key → NOT_FOUND；stat 不存在 → null；重复 delete → 第二次 false', async () => {
    const storage = new LocalStorageProvider(root);
    const key = buildKey(7, 'png');
    await expect(storage.read(key)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await storage.stat(key)).toBeNull();

    await storage.save(key, Buffer.from('png-bytes'));
    expect(await storage.exists(key)).toBe(true);
    const stat = await storage.stat(key);
    expect(stat?.bytes).toBe(9);
    expect(stat?.modifiedAt).toMatch(/Z$/);

    expect(await storage.delete(key)).toBe(true);
    expect(await storage.delete(key)).toBe(false);
    expect(await storage.stat(key)).toBeNull();
  });
});
