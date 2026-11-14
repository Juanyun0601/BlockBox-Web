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
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'muted', 'banned')),
  muted_until   INTEGER NOT NULL DEFAULT 0,
  mute_scope    TEXT    NOT NULL DEFAULT 'all',
  mute_reason   TEXT    NOT NULL DEFAULT '',
  mute_by       TEXT    NOT NULL DEFAULT '',
  thread_count  INTEGER NOT NULL DEFAULT 0,
  post_count    INTEGER NOT NULL DEFAULT 0,
  points        INTEGER NOT NULL DEFAULT 0,   -- 论坛积分「方块」，目前来自每日签到
  makeup_cards  INTEGER NOT NULL DEFAULT 0,   -- 补签卡数量，可补昨天漏签
  quiz_passed_at  INTEGER NOT NULL DEFAULT 0,
  quiz_best_score INTEGER NOT NULL DEFAULT -1,
  email_verified_at INTEGER NOT NULL DEFAULT 0,
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

-- 每日签到（论坛积分「方块」）----------------------------------------
-- day 是论坛时区（Asia/Shanghai）的日期 YYYY-MM-DD，一人一天只有一条；
-- streak_day 是连续签到的第几天（1 起），奖励看第几天发，第 8 天起固定 20。
CREATE TABLE IF NOT EXISTS point_checkins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         TEXT    NOT NULL,
  streak_day  INTEGER NOT NULL DEFAULT 1,
  points      INTEGER NOT NULL DEFAULT 0,
  sunday_gift INTEGER NOT NULL DEFAULT 0,   -- 当天是周日并领到了神秘礼包
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_point_checkins_user ON point_checkins(user_id, day DESC);

-- 方块收支流水：目前只有签到，后面加兑换 / 神秘礼包也记这里
CREATE TABLE IF NOT EXISTS point_transactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     INTEGER NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'checkin' CHECK (kind IN ('checkin', 'gift', 'admin', 'spend')),
  note       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_point_transactions_user ON point_transactions(user_id, created_at DESC);

-- 每周天的神秘礼包（占位：先记下「本周已领」，内容以后再补发放逻辑）
CREATE TABLE IF NOT EXISTS point_gifts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week       TEXT    NOT NULL,              -- 当周周日的日期 YYYY-MM-DD
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed')),
  prize      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, week)
);

CREATE INDEX IF NOT EXISTS idx_point_gifts_user ON point_gifts(user_id, status);


-- 邮箱验证码（一封邮箱同时只有一份有效码，重发即覆盖；只存哈希不存明文）
CREATE TABLE IF NOT EXISTS email_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

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

-- 资源详情页评论（插件帖 / 投影帖专用）-----------------------------------
-- 资源和讨论分开：帖子楼层记「必读的介绍与答疑」，评论记「看过之后随口说两句」。
-- 因此这里不设楼层号、不设楼中楼，只有一条条平铺的评论，排序按「最热 + 最新」综合。
CREATE TABLE IF NOT EXISTS thread_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_comments_thread ON thread_comments(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thread_comments_author ON thread_comments(author_id, created_at DESC);

-- 评论点赞 ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comment_likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id INTEGER NOT NULL REFERENCES thread_comments(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id);

-- 评论举报（和楼层举报分开存，管理后台合并成同一个审核队列）-------------
CREATE TABLE IF NOT EXISTS comment_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id  INTEGER NOT NULL REFERENCES thread_comments(id) ON DELETE CASCADE,
  thread_id   INTEGER NOT NULL,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  category    TEXT    NOT NULL DEFAULT '',
  reason      TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  handled_by  INTEGER,
  handled_at  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comment_reports_status ON comment_reports(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_reports_dedupe ON comment_reports(comment_id, reporter_id);

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
  meta       TEXT    NOT NULL DEFAULT '{}',
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id, created_at DESC);

-- 帖子挂载的插件（插件帖）------------------------------------------------
-- 每个主题最多挂一个插件包，绑定的是发帖人自己上传的 uploads 记录。
-- 清单字段一律以服务端解开包后读到的为准，不信任客户端上报的值。
CREATE TABLE IF NOT EXISTS thread_plugins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   INTEGER NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
  upload_id   INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  plugin_id   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  version     TEXT    NOT NULL DEFAULT '',
  author      TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL DEFAULT '',
  icon        TEXT    NOT NULL DEFAULT '',
  file_size   INTEGER NOT NULL DEFAULT 0,
  file_hash   TEXT    NOT NULL DEFAULT '',
  downloads   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_plugins_thread ON thread_plugins(thread_id);
CREATE INDEX IF NOT EXISTS idx_thread_plugins_plugin ON thread_plugins(plugin_id);

-- 插件作品的历史版本（上传新版本留档）--------------------------------------
-- 展示与下载的始终是 thread_plugins 里那一行（最新版）；
-- 上传新版本时，旧包先原样挪进这张表留档，下载计数按版本各自累计。
CREATE TABLE IF NOT EXISTS plugin_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  upload_id   INTEGER NOT NULL UNIQUE REFERENCES uploads(id) ON DELETE CASCADE,
  uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  version     TEXT    NOT NULL DEFAULT '',
  author      TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL DEFAULT '',
  icon        TEXT    NOT NULL DEFAULT '',
  file_size   INTEGER NOT NULL DEFAULT 0,
  file_hash   TEXT    NOT NULL DEFAULT '',
  downloads   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_versions_thread ON plugin_versions(thread_id, id DESC);

-- 帖子挂载的投影文件（投影帖）--------------------------------------------
-- 和插件帖一样一帖一个：发帖人先 POST /api/upload/schematic 拿到 upload_id，
-- 再随主题一起绑定。服务端不解析投影内容，只记原文件名 / 大小 / 指纹，
-- 下载时按 uploads 里的路径发文件。
CREATE TABLE IF NOT EXISTS thread_schematics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
  upload_id  INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL DEFAULT '',
  file_name  TEXT    NOT NULL DEFAULT '',
  file_size  INTEGER NOT NULL DEFAULT 0,
  file_hash  TEXT    NOT NULL DEFAULT '',
  downloads  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_schematics_thread ON thread_schematics(thread_id);

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
  category   TEXT    NOT NULL DEFAULT '',
  reason     TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  handled_by INTEGER,
  handled_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_dedupe ON reports(post_id, reporter_id);

-- 违禁词（管理后台「审核」页维护，命中的内容直接拦下）-------------------
-- ban_hours 是命中后自动禁言的时长，0 表示永久（需要管理员手动解除）；
-- 只检查发帖 / 回复（含修改后的内容），私信与群聊不拦。
CREATE TABLE IF NOT EXISTS banned_words (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  word        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  reason      TEXT    NOT NULL DEFAULT '',
  ban_hours   INTEGER NOT NULL DEFAULT 24,
  enabled     INTEGER NOT NULL DEFAULT 1,
  hits        INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_banned_words_enabled ON banned_words(enabled);

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
  kind       TEXT    NOT NULL DEFAULT 'text',
  image      TEXT    NOT NULL DEFAULT '',
  file_url   TEXT    NOT NULL DEFAULT '',
  file_name  TEXT    NOT NULL DEFAULT '',
  file_size  INTEGER NOT NULL DEFAULT 0,
  reply_to   INTEGER NOT NULL DEFAULT 0,
  read_at    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(sender_id, peer_id, id);
CREATE INDEX IF NOT EXISTS idx_dm_inbox ON direct_messages(peer_id, read_at);

-- 群聊（avatar 是群图标，空 = 客户端按群名首字显示；announcement 是群公告）----
CREATE TABLE IF NOT EXISTS chat_groups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  avatar       TEXT    NOT NULL DEFAULT '',
  announcement TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

-- 成员已读指针：last_read_id 之前的群消息视为已读
CREATE TABLE IF NOT EXISTS chat_group_members (
  group_id     INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_user ON chat_group_members(user_id);

-- 群消息（无全局已读：未读数按各成员的 last_read_id 算）
CREATE TABLE IF NOT EXISTS group_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'text',
  image      TEXT    NOT NULL DEFAULT '',
  file_url   TEXT    NOT NULL DEFAULT '',
  file_name  TEXT    NOT NULL DEFAULT '',
  file_size  INTEGER NOT NULL DEFAULT 0,
  reply_to   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gm_group ON group_messages(group_id, id);

-- 聊天文件每周下载提取流量（week_start = 周一 0 点的 unix 秒）----------
CREATE TABLE IF NOT EXISTS chat_download_usage (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start INTEGER NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, week_start)
);

-- 用户反馈（官网/论坛页脚和启动器提交的问题反馈，管理后台处理）-----------
CREATE TABLE IF NOT EXISTS feedbacks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT    NOT NULL DEFAULT 'bug' CHECK (type IN ('bug', 'feature')),
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

-- 联机大厅（启动器把本机开好的房间发布到这里，网页端只读邀请码）-----------
-- heartbeat_at 是最近一次心跳时间，超过 2 分钟没心跳就当作房间已关闭；
-- 客户端在房间开着的时候每 40 秒续一次期，离开房间就主动删掉这一行。
CREATE TABLE IF NOT EXISTS lobby_rooms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  core         TEXT    NOT NULL DEFAULT 'custom',
  invite_code  TEXT    NOT NULL DEFAULT '',
  address      TEXT    NOT NULL DEFAULT '',
  game_version TEXT    NOT NULL DEFAULT '',
  loader       TEXT    NOT NULL DEFAULT '',
  mods         TEXT    NOT NULL DEFAULT '[]',
  mods_aux     TEXT    NOT NULL DEFAULT '[]',
  resource_packs TEXT  NOT NULL DEFAULT '[]',
  shader_packs TEXT    NOT NULL DEFAULT '[]',
  max_players  INTEGER NOT NULL DEFAULT 8,
  cover        TEXT    NOT NULL DEFAULT '',
  md           TEXT    NOT NULL DEFAULT '',
  modpack_mode TEXT    NOT NULL DEFAULT '' CHECK (modpack_mode IN ('', 'online', 'link')),
  modpack_name TEXT    NOT NULL DEFAULT '',
  modpack_url  TEXT    NOT NULL DEFAULT '',
  modpack_meta TEXT    NOT NULL DEFAULT '{}',
  status       TEXT    NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'full')),
  join_count   INTEGER NOT NULL DEFAULT 0,
  heartbeat_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lobby_rooms_owner ON lobby_rooms(owner_id);
CREATE INDEX IF NOT EXISTS idx_lobby_rooms_active ON lobby_rooms(heartbeat_at DESC);

-- 联机分享短链（「创建分享链接」时把房间信息存进来，链接里只带一段随机房间号）-------
-- 和 lobby_rooms 一样靠心跳续命：房主联机期间每 40 秒续一次，超过 2 分钟没心跳就
-- 当作联机已结束，打开链接时网页和客户端都提示「联机可能已经结束」。
-- secret 只发给房主，续期和删除要带它，别人拿到链接也改不了这条数据。
CREATE TABLE IF NOT EXISTS lobby_shares (
  token        TEXT    PRIMARY KEY,
  secret       TEXT    NOT NULL,
  payload      TEXT    NOT NULL,
  owner_id     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lobby_shares_heartbeat ON lobby_shares(heartbeat_at DESC);

-- 联机大厅「正在游玩」：客户端进游戏后每 40 秒上报一次，超过 2 分钟没上报就当作已经离开。
-- 房主不用落这张表（房间还在就说明房主在房间里），这里只记通过客户端进房的其他玩家。
CREATE TABLE IF NOT EXISTS lobby_players (
  room_id      INTEGER NOT NULL REFERENCES lobby_rooms(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at    INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_lobby_players_heartbeat ON lobby_players(heartbeat_at DESC);

-- 联机大厅房间评论：详情页里大家对着房间留言，房主和评论者自己可以删。
-- 评论跟着房间走：房间过期下架时一并清掉（大厅房间本身就是临时的）。
CREATE TABLE IF NOT EXISTS lobby_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES lobby_rooms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lobby_comments_room ON lobby_comments(room_id, created_at DESC);

-- 启动器首页公告（管理后台「首页公告」维护，发布后写进官网 announcement.json）--
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL,
  link       TEXT    NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_by TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at DESC);

-- 启动重要公告（带标题的 Markdown 正文，启动器启动时弹窗；同一时间只生效一条）--
CREATE TABLE IF NOT EXISTS important_announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL,
  link       TEXT    NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_by TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_important_announcements_created ON important_announcements(created_at DESC);

-- 访问记录（页面浏览明细，管理后台的访问量 / 日活 / 月活都从这里算）---
-- 只记真实用户打开的 HTML 页面：接口请求、图片等静态资源和爬虫都不记。
CREATE TABLE IF NOT EXISTS visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT    NOT NULL,              -- 本地日期 YYYY-MM-DD，按天统计用
  visitor    TEXT    NOT NULL,              -- 访客指纹（IP + 浏览器标识的哈希，不存原始 IP）
  user_id    INTEGER NOT NULL DEFAULT 0,    -- 登录用户 id，游客为 0
  path       TEXT    NOT NULL,              -- 去掉查询串的页面路径
  ref        TEXT    NOT NULL DEFAULT '',   -- 来源页
  ua         TEXT    NOT NULL DEFAULT '',   -- 浏览器标识
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at);
CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day);
CREATE INDEX IF NOT EXISTS idx_visits_day_visitor ON visits(day, visitor);
CREATE INDEX IF NOT EXISTS idx_visits_path ON visits(day, path);

-- 访客档案：每个访客一行，长期保留（明细会被定期清理，累计数据靠它）---
CREATE TABLE IF NOT EXISTS visit_visitors (
  visitor       TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  hits          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_visit_visitors_first ON visit_visitors(first_seen_at);

-- 默认板块（只在不存在时补齐，不会覆盖已修改的名称/排序）
INSERT OR IGNORE INTO boards (slug, name, description, icon, sort_order, created_at) VALUES
  ('general',  '综合讨论',   '关于方块盒子和 Minecraft 的任何话题',        '💬', 10, unixepoch()),
  ('help',     '使用求助',   '安装、启动失败、模组与版本问题，发帖求助',   '🧩', 20, unixepoch()),
  ('guide',    '教程与分享', '玩法心得、配置优化、整合包推荐',             '📘', 30, unixepoch()),
  ('plugin',   '插件与开发', '插件使用、开发文档、编码方块相关',           '🛠️', 40, unixepoch()),
  ('plugin-share', '插件分享', '发布和分享方块盒子插件包，下载后可在软件里一键安装', '🔌', 45, unixepoch()),
  ('schematic-share', '投影分享', '发布和分享 Litematica / WorldEdit 投影文件，下载后放进实例的 schematics 文件夹就能加载', '📐', 46, unixepoch()),
  ('feedback', '意见建议',   '功能建议、缺陷反馈、对官网和论坛的想法',     '💡', 50, unixepoch()),
  ('chat',     '闲聊灌水',   '和方块盒子有关的轻松话题',                   '☕', 60, unixepoch());

-- 版本发布（管理后台「版本发布」维护）--------------------------------------
-- 每行一个版本：版本号 + 更新日志 + 网盘链接 + 是否现行版本。
-- 安装包文件不进库，落 config.releaseDir，库里只记文件清单与指纹；
-- 文件组只保留最新两个正式版和两个测试版，旧版本文件自动清理，
-- 版本号、更新日志与网盘链接则永久保留。
CREATE TABLE IF NOT EXISTS release_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version     TEXT    NOT NULL UNIQUE,
  notes       TEXT    NOT NULL DEFAULT '',
  link_123pan TEXT    NOT NULL DEFAULT '',
  link_quark  TEXT    NOT NULL DEFAULT '',
  link_github TEXT    NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_versions_created ON release_versions(created_at DESC);

CREATE TABLE IF NOT EXISTS release_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id   INTEGER NOT NULL REFERENCES release_versions(id) ON DELETE CASCADE,
  platform     TEXT    NOT NULL,              -- win64 / winarm64 / linux-x64 / linux-arm64 / android / harmony / other
  filename     TEXT    NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT    NOT NULL DEFAULT '',
  downloads    INTEGER NOT NULL DEFAULT 0,    -- 官网/接口直链下载计数（网盘、GitHub 的不记这里）
  created_at   INTEGER NOT NULL,
  UNIQUE(version_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_release_files_version ON release_files(version_id);
