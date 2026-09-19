import { getDb } from '../../server/db/connection';
import * as generations from '../../server/db/repositories/generations';
import * as photos from '../../server/db/repositories/photos';
import * as reverseJobs from '../../server/db/repositories/promptReverseJobs';
import { audit } from '../../server/security/audit';
import { nowIso } from '../../server/domain/time';
import { getStorage } from '../../server/storage';

/**
 * `runPurge()` —— 延迟物理清理（`docs/prd/modules/M08-账号历史与彻底删除.md` §5.3 是唯一事实源）。
 * 不进入任何任务表，由 `src/jobs/worker.ts` 主循环按间隔调用；也可被 `scripts/acceptance.ts`
 * 直接 `import` 后手动触发一次（`DEL-03`）。
 */
export const PURGE_INTERVAL_MS = 10 * 60 * 1000;
export const PURGE_GRACE_MINUTES = 10;
export const PURGE_BATCH_SIZE = 200;

export interface PurgeResult {
  scanned: number;
  purged: number;
  failed: number;
  deletedResults: number;
}

const log = (level: 'warn' | 'info', msg: string, extra: Record<string, unknown> = {}): void => {
  const line = JSON.stringify({ level, scope: 'purge', msg, ...extra, at: nowIso() });
  if (level === 'warn') console.warn(line);
  else console.log(line);
};

const describe = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/**
 * 清理 `deleted_at` 早于 `now - PURGE_GRACE_MINUTES` 的照片：先删磁盘文件（不存在视为成功），
 * 单行失败记 `failed` 并**跳过该行**（保留 `photos` 行，下轮重试），不整批失败；
 * 再在单事务内删 `generation_results` 孤儿行 / `prompt_reverse_jobs` / `photos` 行并逐行写 `photo.purge` 审计。
 * 批满 `PURGE_BATCH_SIZE` 立即续批；异常一律内吞，绝不中断 worker。
 */
export async function runPurge(now?: string): Promise<PurgeResult> {
  const base = now ?? nowIso();
  const threshold = new Date(new Date(base).getTime() - PURGE_GRACE_MINUTES * 60_000).toISOString();
  const total: PurgeResult = { scanned: 0, purged: 0, failed: 0, deletedResults: 0 };
  const storage = getStorage();

  for (;;) {
    const candidates = photos.listPurgeCandidates(threshold, PURGE_BATCH_SIZE);
    if (candidates.length === 0) break;
    total.scanned += candidates.length;

    const purgeable: typeof candidates = [];
    for (const photo of candidates) {
      try {
        const existed = await storage.delete(photo.storageKey);
        if (!existed) {
          log('warn', 'purge: file missing', { photoId: photo.id, storageKey: photo.storageKey });
        }
        purgeable.push(photo);
      } catch (err) {
        total.failed += 1;
        log('warn', 'purge: file delete failed', { photoId: photo.id, error: describe(err) });
      }
    }

    if (purgeable.length > 0) {
      const ids = purgeable.map((photo) => photo.id);
      const deletedResults = getDb().transaction(() => {
        const orphans = generations.deleteOrphanResults();
        reverseJobs.hardDeleteBySourcePhotos(ids);
        photos.hardDeletePhotos(ids);
        for (const photo of purgeable) {
          audit(
            {
              action: 'photo.purge',
              userId: photo.userId,
              target: `photo:${photo.id}`,
              meta: { bytes: photo.bytes, storageKey: photo.storageKey },
            },
            base,
          );
        }
        return orphans;
      })();
      total.purged += purgeable.length;
      total.deletedResults += deletedResults;
    }

    // 批满才续批；整批都失败则停下，把重试留给下一轮（`modules/M08` §5.3）。
    if (candidates.length < PURGE_BATCH_SIZE || purgeable.length === 0) break;
  }

  return total;
}
