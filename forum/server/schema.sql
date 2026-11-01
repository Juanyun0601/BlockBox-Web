-- 方块盒子论坛 · 数据库结构
-- 全部使用 IF NOT EXISTS，服务启动时执行一次即可补齐缺失的表。

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 用户 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL DEFAULT '',
  pass_hash     TEXT    NOT NULL,
  email         TEXT    NOT NULL DEFAULT '',
  bio           TEXT    NOT NULL DEFAULT '',
  avatar        TEXT    NOT NULL DEFAULT '',
  cover         TEXT    NOT NULL DEFAULT '',
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'muted', 'banned')),
  muted_until   INTEGER NOT NULL DEFAULT 0,
  thread_count  INTEGER NOT NULL DEFAULT 0,
  post_count    INTEGER NOT NULL DEFAULT 0,
  quiz_passed_at  INTEGER NOT NULL DEFAULT 0,
  quiz_best_score INTEGER NOT NULL DEFAULT -1,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 登录会话 -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT NOT NULL DEFAULT '',
  ua         TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 板块 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  icon         TEXT    NOT NULL DEFAULT '💬',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  thread_count INTEGER NOT NULL DEFAULT 0,
  post_count   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

-- 主题 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS threads (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id          INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  author_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT    NOT NULL,
  pinned            INTEGER NOT NULL DEFAULT 0,
  locked            INTEGER NOT NULL DEFAULT 0,
  deleted           INTEGER NOT NULL DEFAULT 0,
  views             INTEGER NOT NULL DEFAULT 0,
  reply_count       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  last_post_at      INTEGER NOT NULL,
  last_post_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_board ON threads(board_id, pinned DESC, last_post_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_latest ON threads(deleted, last_post_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_author ON threads(author_id, created_at DESC);

-- 楼层 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id      INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  floor          INTEGER NOT NULL,
  parent_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  content        TEXT    NOT NULL,
  deleted        INTEGER NOT NULL DEFAULT 0,
  edit_count     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_thread_floor ON posts(thread_id, floor);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at DESC);
-- 注意：parent_post_id 的索引在 db.js 的 migrate() 里建，
-- 因为老库要先 ALTER TABLE 补列，这里建会报 no such column。

-- 点赞（按楼层）-------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_post_likes_post ON post_likes(post_id);

-- 收藏（按主题）-------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id  INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_thread ON bookmarks(thread_id);

-- 资源收藏（启动器在线资源：模组 / 整合包等，meta 为客户端资源快照 JSON）--
CREATE TABLE IF NOT EXISTS content_favorites (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       TEXT    NOT NULL,
  remote_id    TEXT    NOT NULL,
  content_type TEXT    NOT NULL DEFAULT '',
  meta         TEXT    NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, source, remote_id)
);

CREATE INDEX IF NOT EXISTS idx_content_favorites_user ON content_favorites(user_id);

-- 主题标签 ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thread_tags (
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  tag       TEXT    NOT NULL,
  PRIMARY KEY (thread_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_thread_tags_tag ON thread_tags(tag);

-- 推荐 / 置顶标签（管理员维护）---------------------------------------
CREATE TABLE IF NOT EXISTS tag_features (
  tag        TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 用户上传的图片（相册）---------------------------------------------
CREATE TABLE IF NOT EXISTS uploads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url        TEXT    NOT NULL,
  thumb      TEXT,
  mime       TEXT    NOT NULL DEFAULT '',
  width      INTEGER NOT NULL DEFAULT 0,
  height     INTEGER NOT NULL DEFAULT 0,
  size       INTEGER NOT NULL DEFAULT 0,
  kind       TEXT    NOT NULL DEFAULT 'img',
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id, created_at DESC);

-- 搜索用索引表（主题标题 + 正文摘要，避免搜索时全表扫楼层）
CREATE TABLE IF NOT EXISTS thread_search (
  thread_id  INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  board_id   INTEGER NOT NULL,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_search_board ON thread_search(board_id);

-- 站内通知（有人回复我的主题、有人 @ 我）-----------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL DEFAULT 'reply' CHECK (type IN ('reply', 'mention', 'system')),
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  thread_id    INTEGER REFERENCES threads(id) ON DELETE CASCADE,
  post_id      INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  thread_title TEXT    NOT NULL DEFAULT '',
  excerpt      TEXT    NOT NULL DEFAULT '',
  read_at      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at);

-- 举报（楼层被举报后进管理后台审核队列）---------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  thread_id  INTEGER NOT NULL,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason     TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  handled_by INTEGER,
  handled_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_dedupe ON reports(post_id, reporter_id);

-- 好友关系（requester 向 addressee 发申请，通过后 status = accepted）-----------------
CREATE TABLE IF NOT EXISTS friendships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (requester_id, addressee_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status);

-- 好友私信 -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS direct_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  read_at    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(sender_id, peer_id, id);
CREATE INDEX IF NOT EXISTS idx_dm_inbox ON direct_messages(peer_id, read_at);

-- 用户反馈（官网/论坛页脚和启动器提交的问题反馈，管理后台处理）-----------
CREATE TABLE IF NOT EXISTS feedbacks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source      TEXT    NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'launcher')),
  content     TEXT    NOT NULL,
  app_version TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  reply       TEXT    NOT NULL DEFAULT '',
  handled_by  INTEGER,
  handled_at  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedbacks_user ON feedbacks(user_id, created_at DESC);

-- 默认板块（只在不存在时补齐，不会覆盖已修改的名称/排序）
INSERT OR IGNORE INTO boards (slug, name, description, icon, sort_order, created_at) VALUES
  ('general',  '综合讨论',   '关于方块盒子和 Minecraft 的任何话题',        '💬', 10, unixepoch()),
  ('help',     '使用求助',   '安装、启动失败、模组与版本问题，发帖求助',   '🧩', 20, unixepoch()),
  ('guide',    '教程与分享', '玩法心得、配置优化、整合包推荐',             '📘', 30, unixepoch()),
  ('plugin',   '插件与开发', '插件使用、开发文档、编码方块相关',           '🛠️', 40, unixepoch()),
  ('feedback', '意见建议',   '功能建议、缺陷反馈、对官网和论坛的想法',     '💡', 50, unixepoch()),
  ('chat',     '闲聊灌水',   '和方块盒子有关的轻松话题',                   '☕', 60, unixepoch());
