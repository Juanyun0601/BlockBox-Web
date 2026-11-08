import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, ROOT_DIR } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');

const schema = fs.readFileSync(path.join(ROOT_DIR, 'server', 'schema.sql'), 'utf8');
db.exec(schema);

db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO NOTHING").run();

/**
 * 给老数据库补字段：SQLite 的 ALTER TABLE 没有 IF NOT EXISTS，
 * 所以先查 PRAGMA table_info，缺了才加。
 */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** 结构升级（每次启动跑一遍，重复执行无副作用） */
export function migrate() {
  // 论坛积分「方块」：老库补一列，放在重建 users 表之前，重建时才能原样带走余额
  const addedPoints = ensureColumn('users', 'points', 'INTEGER NOT NULL DEFAULT 0');
  if (addedPoints) console.log('[论坛] 数据库已升级：users 增加 points（方块积分）');
  const addedMakeupCards = ensureColumn('users', 'makeup_cards', 'INTEGER NOT NULL DEFAULT 0');
  if (addedMakeupCards) console.log('[论坛] 数据库已升级：users 增加 makeup_cards（补签卡）');

  const addedParent = ensureColumn('posts', 'parent_post_id', 'INTEGER REFERENCES posts(id) ON DELETE SET NULL');
  if (addedParent) console.log('[论坛] 数据库已升级：posts 增加 parent_post_id（楼中楼）');
  db.exec('CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_post_id)');

  // 通知区分「回复主题」和「回复我的楼层」
  const addedKind = ensureColumn('notifications', 'target_kind', "TEXT NOT NULL DEFAULT 'thread'");
  if (addedKind) console.log('[论坛] 数据库已升级：notifications 增加 target_kind');

  // 个人主页封面图
  const addedCover = ensureColumn('users', 'cover', "TEXT NOT NULL DEFAULT ''");
  if (addedCover) console.log('[论坛] 数据库已升级：users 增加 cover（个人主页封面）');

  // 入站答题：通过时间与历史最高分（0 表示尚未通过）
  const addedQuizPassed = ensureColumn('users', 'quiz_passed_at', 'INTEGER NOT NULL DEFAULT 0');
  if (addedQuizPassed) console.log('[论坛] 数据库已升级：users 增加 quiz_passed_at（入站答题通过时间）');
  const addedQuizScore = ensureColumn('users', 'quiz_best_score', 'INTEGER NOT NULL DEFAULT -1');
  if (addedQuizScore) console.log('[论坛] 数据库已升级：users 增加 quiz_best_score（答题历史最高分）');

  // 用户反馈区分类型（问题反馈 / 功能建议）
  const addedFeedbackType = ensureColumn('feedbacks', 'type', "TEXT NOT NULL DEFAULT 'bug'");
  if (addedFeedbackType) console.log('[论坛] 数据库已升级：feedbacks 增加 type（反馈类型）');

  // 私信支持图片 / 回复引用 / 撤回占位
  const addedDmKind = ensureColumn('direct_messages', 'kind', "TEXT NOT NULL DEFAULT 'text'");
  if (addedDmKind) console.log('[论坛] 数据库已升级：direct_messages 增加 kind（消息类型）');
  const addedDmImage = ensureColumn('direct_messages', 'image', "TEXT NOT NULL DEFAULT ''");
  if (addedDmImage) console.log('[论坛] 数据库已升级：direct_messages 增加 image（图片地址）');
  const addedDmReply = ensureColumn('direct_messages', 'reply_to', 'INTEGER NOT NULL DEFAULT 0');
  if (addedDmReply) console.log('[论坛] 数据库已升级：direct_messages 增加 reply_to（引用的消息）');

  // 联机大厅：封面图 / Markdown 介绍 / 前置整合包（在线选择或名称+链接）
  // 老库的 lobby_rooms 没有 modpack_mode 的 CHECK 约束，补列时不加约束，应用层校验
  const addedLobbyCover = ensureColumn('lobby_rooms', 'cover', "TEXT NOT NULL DEFAULT ''");
  if (addedLobbyCover) console.log('[论坛] 数据库已升级：lobby_rooms 增加 cover（房间封面）');
  const addedLobbyMd = ensureColumn('lobby_rooms', 'md', "TEXT NOT NULL DEFAULT ''");
  if (addedLobbyMd) console.log('[论坛] 数据库已升级：lobby_rooms 增加 md（Markdown 介绍）');
  const addedLobbyPackMode = ensureColumn('lobby_rooms', 'modpack_mode', "TEXT NOT NULL DEFAULT ''");
  if (addedLobbyPackMode) console.log('[论坛] 数据库已升级：lobby_rooms 增加 modpack_mode（前置整合包模式）');
  const addedLobbyPackName = ensureColumn('lobby_rooms', 'modpack_name', "TEXT NOT NULL DEFAULT ''");
  if (addedLobbyPackName) console.log('[论坛] 数据库已升级：lobby_rooms 增加 modpack_name（前置整合包名称）');
  const addedLobbyPackUrl = ensureColumn('lobby_rooms', 'modpack_url', "TEXT NOT NULL DEFAULT ''");
  if (addedLobbyPackUrl) console.log('[论坛] 数据库已升级：lobby_rooms 增加 modpack_url（前置整合包地址）');
  const addedLobbyPackMeta = ensureColumn('lobby_rooms', 'modpack_meta', "TEXT NOT NULL DEFAULT '{}'");
  if (addedLobbyPackMeta) console.log('[论坛] 数据库已升级：lobby_rooms 增加 modpack_meta（前置整合包信息快照）');

  // 用户角色新增「次级管理员」：老库的 CHECK 约束没这一档，需要重建 users 表
  const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || '';
  if (usersSql && !usersSql.includes('moderator')) {
    // foreign_keys 开关在事务内是空操作，必须在事务外切
    db.exec('PRAGMA foreign_keys = OFF');
    transaction(() => {
      db.exec(
        `CREATE TABLE users_new (
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
          thread_count  INTEGER NOT NULL DEFAULT 0,
          post_count    INTEGER NOT NULL DEFAULT 0,
          points        INTEGER NOT NULL DEFAULT 0,
          makeup_cards  INTEGER NOT NULL DEFAULT 0,
          quiz_passed_at  INTEGER NOT NULL DEFAULT 0,
          quiz_best_score INTEGER NOT NULL DEFAULT -1,
          created_at    INTEGER NOT NULL,
          last_seen_at  INTEGER NOT NULL DEFAULT 0
        )`,
      );
      // 老库的列是 ALTER TABLE 追加的，物理顺序和新建表不同，必须按列名对齐拷贝
      db.exec(
        `INSERT INTO users_new (id, username, display_name, pass_hash, email, bio, avatar, cover,
                                role, status, muted_until, thread_count, post_count, points, makeup_cards,
                                quiz_passed_at, quiz_best_score, created_at, last_seen_at)
         SELECT id, username, display_name, pass_hash, email, bio, avatar, cover,
                role, status, muted_until, thread_count, post_count, points, makeup_cards,
                quiz_passed_at, quiz_best_score, created_at, last_seen_at
           FROM users`,
      );
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
    });
    db.exec('PRAGMA foreign_keys = ON');
    console.log('[论坛] 数据库已升级：用户角色支持次级管理员（moderator）');
  }

  // 禁言细化：禁止哪些内容、理由、操作人（放在最后，兼容上面重建 users 表的老库）
  const addedMuteScope = ensureColumn('users', 'mute_scope', "TEXT NOT NULL DEFAULT 'all'");
  if (addedMuteScope) console.log('[论坛] 数据库已升级：users 增加 mute_scope（禁言范围）');
  const addedMuteReason = ensureColumn('users', 'mute_reason', "TEXT NOT NULL DEFAULT ''");
  if (addedMuteReason) console.log('[论坛] 数据库已升级：users 增加 mute_reason（禁言理由）');
  const addedMuteBy = ensureColumn('users', 'mute_by', "TEXT NOT NULL DEFAULT ''");
  if (addedMuteBy) console.log('[论坛] 数据库已升级：users 增加 mute_by（禁言操作人）');

  // 邮箱验证：记录通过验证码验证的时间（0 = 未验证）；改绑新邮箱会清零
  const addedEmailVerified = ensureColumn('users', 'email_verified_at', 'INTEGER NOT NULL DEFAULT 0');
  if (addedEmailVerified) console.log('[论坛] 数据库已升级：users 增加 email_verified_at（邮箱验证时间）');

  // 插件帖：uploads 增加 meta（插件包的清单快照与 sha256，图片类上传恒为 '{}'）
  const addedUploadMeta = ensureColumn('uploads', 'meta', "TEXT NOT NULL DEFAULT '{}'");
  if (addedUploadMeta) console.log('[论坛] 数据库已升级：uploads 增加 meta（插件包元数据）');

  // 版本发布：网盘链接（123 盘 / 夸克）。安装包文件组只保留最新两正式 + 两测试，
  // 旧版本文件自动清理，但版本号、更新日志与网盘链接永久留在版本表里
  const addedLink123 = ensureColumn('release_versions', 'link_123pan', "TEXT NOT NULL DEFAULT ''");
  if (addedLink123) console.log('[论坛] 数据库已升级：release_versions 增加 link_123pan（123 盘链接）');
  const addedLinkQuark = ensureColumn('release_versions', 'link_quark', "TEXT NOT NULL DEFAULT ''");
  if (addedLinkQuark) console.log('[论坛] 数据库已升级：release_versions 增加 link_quark（夸克网盘链接）');
  const addedLinkGithub = ensureColumn('release_versions', 'link_github', "TEXT NOT NULL DEFAULT ''");
  if (addedLinkGithub) console.log('[论坛] 数据库已升级：release_versions 增加 link_github（GitHub Release 链接）');

  // 举报分类（客户端举报页选的分类 slug；网页版旧数据为空）
  const addedReportCategory = ensureColumn('reports', 'category', "TEXT NOT NULL DEFAULT ''");
  if (addedReportCategory) console.log('[论坛] 数据库已升级：reports 增加 category（举报分类）');

  // 聊天支持发文件：私信 / 群消息各加三个字段（站内文件路径、原始文件名、字节数）
  for (const table of ['direct_messages', 'group_messages']) {
    const addedFileUrl = ensureColumn(table, 'file_url', "TEXT NOT NULL DEFAULT ''");
    const addedFileName = ensureColumn(table, 'file_name', "TEXT NOT NULL DEFAULT ''");
    const addedFileSize = ensureColumn(table, 'file_size', 'INTEGER NOT NULL DEFAULT 0');
    if (addedFileUrl || addedFileName || addedFileSize) {
      console.log(`[论坛] 数据库已升级：${table} 增加 file_url / file_name / file_size（聊天文件）`);
    }
  }
}

migrate();

/** 当前时间（秒） */
export const now = () => Math.floor(Date.now() / 1000);

/** 在一个写事务里执行，出错自动回滚 */
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 忽略回滚失败 */
    }
    throw error;
  }
}

/** 分页参数：page 从 1 开始，perPage 有上限 */
export function paginate(searchParams, defaultPerPage = 20, maxPerPage = 60) {
  const page = Math.max(1, Math.floor(Number(searchParams.get('page') || 1)) || 1);
  const perPageRaw = Math.floor(Number(searchParams.get('per_page') || defaultPerPage)) || defaultPerPage;
  const perPage = Math.min(maxPerPage, Math.max(1, perPageRaw));
  return { page, perPage, offset: (page - 1) * perPage };
}

/** 统计某个板块的主题 / 楼层数量 */
export function refreshBoardCounts(boardId) {
  db.prepare(
    `UPDATE boards SET
       thread_count = (SELECT COUNT(*) FROM threads WHERE board_id = ? AND deleted = 0),
       post_count   = (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id
                       WHERE t.board_id = ? AND t.deleted = 0 AND p.deleted = 0)
     WHERE id = ?`,
  ).run(boardId, boardId, boardId);
}

/** 清理过期会话，启动时与定时任务调用 */
export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}
