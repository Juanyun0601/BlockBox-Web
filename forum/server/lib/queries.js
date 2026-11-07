import { db } from '../db.js';

const THREAD_SELECT = `
  SELECT t.id, t.title, t.pinned, t.locked, t.views, t.reply_count, t.created_at, t.last_post_at,
         b.id AS board_id, b.slug AS board_slug, b.name AS board_name, b.icon AS board_icon,
         u.id AS author_id, u.username AS author_username,
         u.display_name AS author_display_name, u.avatar AS author_avatar,
         lu.username AS last_username, lu.display_name AS last_display_name,
         (SELECT group_concat(tt.tag, ',') FROM thread_tags tt WHERE tt.thread_id = t.id) AS tag_list,
         (SELECT p.content FROM posts p
           WHERE p.thread_id = t.id AND p.deleted = 0
           ORDER BY p.floor LIMIT 1) AS first_post,
         tp.id AS tp_id, tp.upload_id AS tp_upload_id, tp.plugin_id AS tp_plugin_id,
         tp.name AS tp_name, tp.version AS tp_version, tp.author AS tp_author,
         tp.description AS tp_description, tp.icon AS tp_icon,
         tp.file_size AS tp_file_size, tp.downloads AS tp_downloads
    FROM threads t
    JOIN boards b ON b.id = t.board_id
    JOIN users u ON u.id = t.author_id
    LEFT JOIN users lu ON lu.id = t.last_post_user_id
    LEFT JOIN thread_plugins tp ON tp.thread_id = t.id`;

const THREAD_ORDER = {
  latest: 't.pinned DESC, t.last_post_at DESC',
  new: 't.pinned DESC, t.created_at DESC',
  hot: 't.pinned DESC, (t.reply_count * 4 + t.views) DESC, t.last_post_at DESC',
};

export function listThreads({ boardId = null, authorId = null, tag = '', sort = 'latest', limit = 20, offset = 0 }) {
  const where = ['t.deleted = 0'];
  const params = [];
  if (boardId) {
    where.push('t.board_id = ?');
    params.push(boardId);
  }
  if (authorId) {
    where.push('t.author_id = ?');
    params.push(authorId);
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM thread_tags tt WHERE tt.thread_id = t.id AND tt.tag = ?)');
    params.push(tag);
  }
  const order = THREAD_ORDER[sort] || THREAD_ORDER.latest;
  const sql = `${THREAD_SELECT}
    WHERE ${where.join(' AND ')}
    ORDER BY ${order}
    LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, limit, offset);
}

export function countThreads({ boardId = null, authorId = null, tag = '' } = {}) {
  const where = ['deleted = 0'];
  const params = [];
  if (boardId) {
    where.push('board_id = ?');
    params.push(boardId);
  }
  if (authorId) {
    where.push('author_id = ?');
    params.push(authorId);
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM thread_tags tt WHERE tt.thread_id = threads.id AND tt.tag = ?)');
    params.push(tag);
  }
  return db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE ${where.join(' AND ')}`).get(...params).n;
}

export function getThread(id) {
  return db.prepare(`${THREAD_SELECT} WHERE t.id = ?`).get(id);
}

const POST_SELECT = `
  SELECT p.id, p.thread_id, p.author_id, p.floor, p.parent_post_id, p.content, p.deleted, p.edit_count,
         p.created_at, p.updated_at,
         u.username, u.display_name, u.avatar, u.role, u.status,
         u.thread_count AS u_thread_count, u.post_count AS u_post_count,
         u.created_at AS u_created_at,
         (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count
    FROM posts p
    LEFT JOIN users u ON u.id = p.author_id`;

/** 顶层楼层（不含楼中楼），被删除的楼层保留占位，避免楼层号跳号 */
export function listPosts(threadId, limit = 20, offset = 0) {
  return db
    .prepare(
      `${POST_SELECT}
        WHERE p.thread_id = ? AND p.parent_post_id IS NULL
        ORDER BY p.floor ASC
        LIMIT ? OFFSET ?`,
    )
    .all(threadId, limit, offset);
}

export function countPosts(threadId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM posts WHERE thread_id = ? AND parent_post_id IS NULL')
    .get(threadId).n;
}

/** 一次性取出这些父楼层下的所有楼中楼 */
export function listChildPosts(parentIds) {
  if (!parentIds.length) return [];
  const placeholders = parentIds.map(() => '?').join(',');
  return db
    .prepare(
      `${POST_SELECT}
        WHERE p.parent_post_id IN (${placeholders})
        ORDER BY p.id ASC`,
    )
    .all(...parentIds);
}

/** 某条楼层下面的楼中楼数量（列表里显示“查看 N 条回复”） */
export function countChildren(parentId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM posts WHERE parent_post_id = ? AND deleted = 0')
    .get(parentId).n;
}

/** 当前用户在给定楼层里点过赞的集合 */
export function likedPostIds(userId, postIds) {
  if (!userId || postIds.length === 0) return new Set();
  const placeholders = postIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT post_id FROM post_likes WHERE user_id = ? AND post_id IN (${placeholders})`)
    .all(userId, ...postIds);
  return new Set(rows.map((row) => row.post_id));
}

/** 用户收藏的主题 */
export function listBookmarkedThreads(userId, limit = 20, offset = 0) {
  return db
    .prepare(
      `${THREAD_SELECT}
        JOIN bookmarks bm ON bm.thread_id = t.id AND bm.user_id = ?
        WHERE t.deleted = 0
        ORDER BY bm.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(userId, limit, offset);
}

export function countBookmarkedThreads(userId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM bookmarks bm
         JOIN threads t ON t.id = bm.thread_id
        WHERE bm.user_id = ? AND t.deleted = 0`,
    )
    .get(userId).n;
}

/** 热门标签 */
export function popularTags(limit = 12) {
  return db
    .prepare(
      `SELECT tt.tag, COUNT(*) AS n
         FROM thread_tags tt
         JOIN threads t ON t.id = tt.thread_id
        WHERE t.deleted = 0
        GROUP BY tt.tag
        ORDER BY n DESC, tt.tag ASC
        LIMIT ?`,
    )
    .all(limit);
}

/** 用户最近的主题 */
export function listThreadsByAuthor(authorId, limit = 20, offset = 0) {
  return listThreads({ authorId, limit, offset, sort: 'new' });
}

/** 用户最近的回复（带所属主题标题） */
export function listRepliesByAuthor(authorId, limit = 20, offset = 0) {
  return db
    .prepare(
      `SELECT p.id, p.thread_id, p.content, p.created_at, p.deleted,
              t.title AS thread_title, t.deleted AS thread_deleted,
              b.slug AS board_slug, b.name AS board_name
         FROM posts p
         JOIN threads t ON t.id = p.thread_id
         JOIN boards b ON b.id = t.board_id
        WHERE p.author_id = ? AND p.floor > 1 AND p.deleted = 0 AND t.deleted = 0
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(authorId, limit, offset);
}

/** 用户回复总数（与 listRepliesByAuthor 的筛选条件一致） */
export function countRepliesByAuthor(authorId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM posts p
         JOIN threads t ON t.id = p.thread_id
        WHERE p.author_id = ? AND p.floor > 1 AND p.deleted = 0 AND t.deleted = 0`,
    )
    .get(authorId).n;
}

/** 首页 / 侧栏用的站点统计 */
export function siteStats() {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM threads WHERE deleted = 0) AS threads,
         (SELECT COUNT(*) FROM posts WHERE deleted = 0) AS posts,
         (SELECT COUNT(*) FROM users WHERE last_seen_at > ?) AS online,
         (SELECT COUNT(*) FROM users WHERE created_at > ?) AS new_users,
         (SELECT MAX(id) FROM users) AS newest_id`,
    )
    .get(Math.floor(Date.now() / 1000) - 900, Math.floor(Date.now() / 1000) - 86400);
  const newest = row.newest_id
    ? db.prepare('SELECT id, username, display_name, avatar, created_at FROM users WHERE id = ?').get(row.newest_id)
    : null;
  return {
    users: row.users,
    threads: row.threads,
    posts: row.posts,
    online: row.online,
    new_users: row.new_users,
    newest_user: newest
      ? {
          id: newest.id,
          username: newest.username,
          display_name: newest.display_name || newest.username,
          avatar: newest.avatar || '',
          created_at: newest.created_at,
        }
      : null,
  };
}
