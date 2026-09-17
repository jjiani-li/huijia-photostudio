-- ============================================================================
-- 「回家照相馆」· SQLite 首个迁移 (001-init.sql)
-- 权威来源：docs/prd/01-领域模型与数据库.md
-- 约定：时间戳 TEXT / UTC ISO-8601；JSON 列后缀 _json 存 TEXT；布尔用 0/1
-- ============================================================================

PRAGMA foreign_keys = OFF;   -- 软删除语义靠应用层，不启用级联
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

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
  status            INTEGER NOT NULL DEFAULT 1,
  daily_image_quota INTEGER NOT NULL DEFAULT 20,
  created_at        TEXT NOT NULL,
  last_login_at     TEXT,
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
  mime            TEXT NOT NULL,
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
  sample_photo_id INTEGER REFERENCES photos(id),
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
  cover_photo_id INTEGER REFERENCES photos(id),
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
  is_active        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (era_code, scene_id)
);
CREATE INDEX idx_profiles_scene ON era_scene_profiles (scene_id);

-- ── 生成任务 ────────────────────────────────────────────────────────────────
CREATE TABLE generations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  anchor_id          INTEGER NOT NULL REFERENCES identity_anchors(id),
  era_code           TEXT NOT NULL REFERENCES eras(code),
  scene_id           INTEGER NOT NULL REFERENCES scenes(id),
  profile_id         INTEGER REFERENCES era_scene_profiles(id),
  reference_photo_ids TEXT NOT NULL,
  prompt             TEXT NOT NULL,
  prompt_hash        TEXT NOT NULL,
  template_version   TEXT NOT NULL,
  era_pack_version   TEXT NOT NULL,
  scene_pack_version TEXT NOT NULL,
  model              TEXT NOT NULL,
  params_json        TEXT NOT NULL,
  requested_count    INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed')),
  attempt            INTEGER NOT NULL DEFAULT 0,
  error_code         TEXT,
  error_message      TEXT,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT
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
