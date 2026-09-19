import { getDb } from '../connection';
import { nowIso } from '../../domain/time';
import type { Iso } from '../../../shared/types';

/**
 * `audit_logs` 表 SQL（`docs/prd/spec/01-领域模型与数据库.md` §3.14）。
 * `action` 取值域（MVP 16 项）见 `spec/01` §3.14；各动作的写入位置归对应 ticket。
 */
export interface AuditRecord {
  id: number;
  userId: number | null;
  action: string;
  target: string | null;
  meta: unknown;
  createdAt: Iso;
}

interface AuditRow {
  id: number;
  user_id: number | null;
  action: string;
  target: string | null;
  meta_json: string | null;
  created_at: string;
}

const COLUMNS = 'id, user_id, action, target, meta_json, created_at';

const toAudit = (row: AuditRow): AuditRecord => ({
  id: row.id,
  userId: row.user_id,
  action: row.action,
  target: row.target,
  meta: row.meta_json === null ? null : (JSON.parse(row.meta_json) as unknown),
  createdAt: row.created_at,
});

export interface WriteAuditInput {
  action: string;
  userId?: number | null;
  target?: string | null;
  meta?: unknown;
  /** 同一事务内要求逐字符相等的场景（如 `modules/M04` §5.1 ④）由调用方传入 `nowIso()`，否则默认当前时间。 */
  createdAt?: Iso;
}

export const write = (input: WriteAuditInput): AuditRecord => {
  const info = getDb()
    .prepare(
      `INSERT INTO audit_logs (user_id, action, target, meta_json, created_at)
       VALUES (@userId, @action, @target, @metaJson, @createdAt)`,
    )
    .run({
      userId: input.userId ?? null,
      action: input.action,
      target: input.target ?? null,
      metaJson: input.meta === undefined || input.meta === null ? null : JSON.stringify(input.meta),
      createdAt: input.createdAt ?? nowIso(),
    });
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM audit_logs WHERE id = ?`).get(info.lastInsertRowid) as
    | AuditRow
    | undefined;
  if (row === undefined) throw new Error('audit_logs 插入后读回失败');
  return toAudit(row);
};

export const listByUser = (userId: number): AuditRecord[] =>
  (
    getDb()
      .prepare(`SELECT ${COLUMNS} FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as AuditRow[]
  ).map(toAudit);
