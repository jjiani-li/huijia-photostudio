import {
  write as writeAuditRow,
  type AuditRecord,
  type WriteAuditInput,
} from '../db/repositories/audit';

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

export interface WriteAuditFields extends Omit<WriteAuditInput, 'action'> {
  action: AuditAction;
}

export const writeAudit = (input: WriteAuditFields): AuditRecord => writeAuditRow(input);
