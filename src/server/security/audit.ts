import {
  write as writeAuditRow,
  type AuditRecord,
} from '../db/repositories/audit';
import type { Iso } from '../../shared/types';

/**
 * 审计写入的领域层入口（`docs/prd/spec/04-技术基线与目录结构.md` §2 的 `src/server/security/audit`）。
 * 相比 repository 的自由 `action: string`，这里把 `action` 收敛到 `spec/01-领域模型与数据库.md` §3.14
 * 的 MVP 16 项取值，避免拼错或发明新的审计动作。
 */
export type AuditAction =
  | 'auth.code_sent'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.realname'
  | 'photo.upload'
  | 'photo.preprocess'
  | 'photo.mark'
  | 'anchor.extract'
  | 'anchor.confirm'
  | 'consent.agree'
  | 'generation.create'
  | 'generation.finish'
  | 'moderation.reject'
  | 'photo.delete'
  | 'anchor.delete'
  | 'photo.purge';

export interface AuditEntry {
  /** 匿名操作（发码前）为 `null`。 */
  userId: number | null;
  action: AuditAction;
  /** `'anchor:3'` / `'photo:12'` / `'generation:7'`。 */
  target?: string | null;
  /** 只放 id / `attempt` / `scope` / 级联计数等原子值（`modules/M04` §9）。 */
  meta?: Record<string, unknown> | null;
}

/**
 * 审计写入的**唯一业务入口**（`docs/prd/modules/M04-身份确认与授权.md` §9）。
 * **必须在调用方已开启的事务内调用**；写入失败不回吞（抛出异常让整个事务回滚）。
 * 传 `at` 时用于让 `audit_logs.created_at` 与同事务内业务写入的时间戳**逐字符相等**（§5.1 ④）。
 */
export const audit = (entry: AuditEntry, at?: Iso): AuditRecord =>
  writeAuditRow({
    action: entry.action,
    userId: entry.userId,
    target: entry.target,
    meta: entry.meta,
    createdAt: at,
  });
