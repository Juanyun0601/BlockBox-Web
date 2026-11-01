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
