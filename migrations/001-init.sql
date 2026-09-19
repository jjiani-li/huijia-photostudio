-- ============================================================================
-- 「回家照相馆」· SQLite 首个迁移 (001-init.sql)
-- 层级：规范层 · 全局约束（不可违背）／ 上游：docs/prd/spec/01-领域模型与数据库.md ／ 下游：全部下游文档与工单
-- 本文件是 docs/prd/spec/01-领域模型与数据库.md §3 表字典的机器可读版本，即迁移 001-init.sql 全文。
-- 版本：schema v1。执行方式：src/server/db/migrate.ts 按文件名顺序在单事务内执行；重置即删库重跑。
-- 约定：时间戳 TEXT / UTC ISO-8601；JSON 列后缀 _json 存 TEXT；布尔用 0/1；只用 SQLite 原生类型。
-- ============================================================================

-- ⚠️ 本文件不含任何 PRAGMA：SQLite 禁止在事务内切换 journal_mode，而 migrate.ts 对每个迁移
--    文件单事务执行，PRAGMA 写在这里会直接报错或静默失效。所有连接级 PRAGMA
--    （journal_mode=WAL / foreign_keys=OFF / synchronous=NORMAL / busy_timeout=5000）
--    一律由 src/server/db/connection.ts 的 getDb() 在事务之外设置，见
--    spec/04-技术基线与目录结构.md §4.3。
-- ── 迁移记录 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
-- ── 用户 ────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  phone             TEXT UNIQUE,
  email             TEXT UNIQUE,
  nickname          TEXT NOT NULL,
  real_name         TEXT,                   -- 实名姓名；未实名为 NULL
  id_hash           TEXT UNIQUE,            -- 证件号哈希；只存哈希，不存明文
  status            INTEGER NOT NULL DEFAULT 1,
  daily_image_quota INTEGER NOT NULL DEFAULT 20,
  created_at        TEXT NOT NULL,
  last_login_at     TEXT,
  verified_at       TEXT,                   -- 实名通过时间；未实名为 NULL，生成门槛读它
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
-- ── 验证码 ──────────────────────────────────────────────────────────────────
CREATE TABLE login_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier  TEXT NOT NULL,
  code        TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'login',
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_login_codes_identifier ON login_codes (identifier, created_at DESC);
-- ── 会话 ────────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
-- ── 照片资产 ────────────────────────────────────────────────────────────────
CREATE TABLE photos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  kind            TEXT NOT NULL CHECK (kind IN ('original','preprocessed','generated')),
  storage_key     TEXT NOT NULL,
  mime            TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','image/heic')),
  -- mime 允许值的唯一声明处是 spec/01-领域模型与数据库.md §3.4（与 spec/03 §3.2 接受的格式一致）
  bytes           INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  sha256          TEXT NOT NULL,
  source_photo_id INTEGER REFERENCES photos(id),
  quality_json    TEXT,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_photos_user_created ON photos (user_id, created_at DESC);
CREATE INDEX idx_photos_sha256       ON photos (sha256);
CREATE INDEX idx_photos_deleted      ON photos (deleted_at);
-- ── 身份锚点（兼 F1 提取任务） ──────────────────────────────────────────────
CREATE TABLE identity_anchors (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id),
  input_photo_ids       TEXT NOT NULL,
  preprocessed_photo_id INTEGER REFERENCES photos(id),
  status                TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  attempt               INTEGER NOT NULL DEFAULT 0,
  anchor_text           TEXT,
  features_json         TEXT,
  model                 TEXT NOT NULL,
  prompt_version        TEXT NOT NULL,
  quality_json          TEXT,
  error_code            TEXT,
  error_message         TEXT,
  confirmed_by_user     INTEGER NOT NULL DEFAULT 0,
  confirmed_at          TEXT,
  created_at            TEXT NOT NULL,
  started_at            TEXT,
  finished_at           TEXT
);
CREATE INDEX idx_anchors_user_created ON identity_anchors (user_id, created_at DESC);
CREATE INDEX idx_anchors_status       ON identity_anchors (status, created_at);
-- ── 图片反推提示词任务（F4） ────────────────────────────────────────────────
CREATE TABLE prompt_reverse_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  source_photo_id  INTEGER NOT NULL REFERENCES photos(id),
  model            TEXT NOT NULL,
  result_json      TEXT,
  result_prompt    TEXT,
  suggest_era_code TEXT,
  suggest_scene_id INTEGER,
  status           TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  attempt          INTEGER NOT NULL DEFAULT 0,   -- 自动重试记账（spec/03 §2.2）
  error_code       TEXT,                          -- 终态失败时的错误码（PromptReverseJob.error.code 的来源）
  error_message    TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,                          -- 超时与回收判定（spec/03 §2.2）
  finished_at      TEXT
);
CREATE INDEX idx_reverse_user_created ON prompt_reverse_jobs (user_id, created_at DESC);
CREATE INDEX idx_reverse_status       ON prompt_reverse_jobs (status, created_at);
-- ── 配置资产：年代（影像质感层） ────────────────────────────────────────────
CREATE TABLE eras (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  is_mono         INTEGER NOT NULL DEFAULT 0,
  default_size    TEXT NOT NULL DEFAULT '2048x2048',
  style_json      TEXT NOT NULL,
  prompt_pack     TEXT NOT NULL,
  constraint_pack TEXT NOT NULL,
  caption         TEXT NOT NULL,
  sample_photo    TEXT,
  pack_version    TEXT NOT NULL DEFAULT 'v1',
  is_active       INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0
);
-- ── 配置资产：场景（空间光线层） ────────────────────────────────────────────
CREATE TABLE scenes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL,
  category       TEXT,
  space_pack     TEXT NOT NULL,
  caption        TEXT NOT NULL,
  sample_photo   TEXT,
  pack_version   TEXT NOT NULL DEFAULT 'v1',
  is_active      INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0
);
-- ── 配置资产：年代 × 场景 组合矩阵（必须恰好 20 行） ─────────────────────────
CREATE TABLE era_scene_profiles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  era_code         TEXT NOT NULL REFERENCES eras(code),
  scene_id         INTEGER NOT NULL REFERENCES scenes(id),
  visual_signature TEXT NOT NULL,
  prompt_override  TEXT,
  confidence       REAL NOT NULL DEFAULT 1.0,
  sample_photo     TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (era_code, scene_id)
);
CREATE INDEX idx_profiles_scene ON era_scene_profiles (scene_id);
-- ── 生成任务 ────────────────────────────────────────────────────────────────
CREATE TABLE generations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  anchor_id           INTEGER NOT NULL REFERENCES identity_anchors(id),
  era_code            TEXT NOT NULL REFERENCES eras(code),
  scene_id            INTEGER NOT NULL REFERENCES scenes(id),
  profile_id          INTEGER REFERENCES era_scene_profiles(id),
  reference_photo_ids TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  prompt_hash         TEXT NOT NULL,
  template_version    TEXT NOT NULL,
  era_pack_version    TEXT NOT NULL,
  scene_pack_version  TEXT NOT NULL,
  model               TEXT NOT NULL,
  params_json         TEXT NOT NULL,
  requested_count     INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed')),
  attempt             INTEGER NOT NULL DEFAULT 0,
  error_code          TEXT,
  error_message       TEXT,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  finished_at         TEXT
);
CREATE INDEX idx_gen_user_created ON generations (user_id, created_at DESC);
CREATE INDEX idx_gen_status       ON generations (status, created_at);
CREATE INDEX idx_gen_era_scene    ON generations (era_code, scene_id);
CREATE INDEX idx_gen_prompt_hash  ON generations (prompt_hash);
-- ── 生成结果（一个任务多张候选） ────────────────────────────────────────────
CREATE TABLE generation_results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id  INTEGER NOT NULL REFERENCES generations(id),
  photo_id       INTEGER NOT NULL REFERENCES photos(id),
  ordinal        INTEGER NOT NULL,
  seed           INTEGER,
  era_check_json TEXT,
  age_delta      INTEGER,
  realism_score  REAL,
  user_feedback  INTEGER,
  created_at     TEXT NOT NULL,
  UNIQUE (generation_id, ordinal)
);
CREATE INDEX idx_results_generation ON generation_results (generation_id);
-- ── 授权记录 ────────────────────────────────────────────────────────────────
CREATE TABLE consents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  scope      TEXT NOT NULL,
  anchor_id  INTEGER REFERENCES identity_anchors(id),
  agreed_at  TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_consents_user_scope ON consents (user_id, scope);
-- ── 额度计数 ────────────────────────────────────────────────────────────────
CREATE TABLE usage_counters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  day         TEXT NOT NULL,
  generations INTEGER NOT NULL DEFAULT 0,
  images      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, day)
);
-- ── 内容审核记录 ────────────────────────────────────────────────────────────
CREATE TABLE content_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  stage       TEXT NOT NULL CHECK (stage IN ('upload','prompt','result')),
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('pass','reject','review')),
  reason      TEXT,
  model       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_reviews_target ON content_reviews (target_type, target_id);
-- ── 审计日志 ────────────────────────────────────────────────────────────────
CREATE TABLE audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  target     TEXT,
  meta_json  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_user_created ON audit_logs (user_id, created_at DESC);
CREATE INDEX idx_audit_action       ON audit_logs (action, created_at);
-- ── 开发种子：固定 DEV_USER（仅开发环境；幂等 upsert） ─────────────────────
-- 已实名（real_name / verified_at 非空），使 M1/M2 期间的工单（tickets/T03 … tickets/T11）
-- 不被生成门槛 REALNAME_REQUIRED 阻塞；id_hash 是占位值，不是真实证件哈希。
-- 真实登录与实名门槛分别见 tickets/T12、tickets/T19。
INSERT INTO users (id, phone, nickname, real_name, id_hash, status, daily_image_quota,
                   created_at, last_login_at, verified_at)
VALUES (1, '13800000000', 'DEV_USER', '开发用户', 'dev-user-placeholder-hash', 1, 20,
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
ON CONFLICT(id) DO NOTHING;
