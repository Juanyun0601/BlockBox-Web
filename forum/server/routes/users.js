import { db, paginate } from '../db.js';
import { notFound } from '../lib/http.js';
import { isAdminRole, publicUser } from '../lib/auth.js';
import { friendshipBetween } from '../lib/social.js';
import { threadOut, snippetOf } from '../lib/serialize.js';
import { listThreads, countThreads, listRepliesByAuthor, countRepliesByAuthor } from '../lib/queries.js';

export default function register(router) {
  // 注意：这条必须放在 /api/users/:id 前面，否则 "search" 会被当成 id
  router.get('/api/users/search', async (ctx) => {
    const query = String(ctx.url.searchParams.get('q') || '').trim().slice(0, 24);
    if (!query) return { users: [] };
    const like = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const rows = db
      .prepare(
        `SELECT id, username, display_name, avatar, role
           FROM users
          WHERE status != 'banned'
            AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
          ORDER BY post_count DESC, id ASC
          LIMIT 8`,
      )
      .all(like, like);
    return {
      users: rows.map((row) => ({
        id: row.id,
        username: row.username,
        display_name: row.display_name || row.username,
        avatar: row.avatar || '',
        role: row.role,
      })),
    };
  });

  router.get('/api/users/:id', async (ctx) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(ctx.params.id));
    if (!row) throw notFound('用户不存在');
    if (row.status === 'banned' && !isAdminRole(ctx.user?.role) && ctx.user?.id !== row.id) {
      throw notFound('用户不存在');
    }

    const self = ctx.user?.id === row.id;
    // 登录态下附带好友关系，个人主页据此显示 加好友 / 发私信 按钮
    let friendship = 'none';
    if (self) {
      friendship = 'self';
    } else if (ctx.user) {
      const rel = friendshipBetween(ctx.user.id, row.id);
      if (rel) {
        if (rel.status === 'accepted') friendship = 'friends';
        else friendship = rel.requester_id === ctx.user.id ? 'outgoing' : 'incoming';
      }
    }

    return {
      user: publicUser(row, { self }),
      friendship,
      threads: listThreads({ authorId: row.id, limit: 8, sort: 'new' }).map((item) =>
        threadOut(item, { withSnippet: false }),
      ),
      replies: listRepliesByAuthor(row.id, 8, 0).map((item) => ({
        id: item.id,
        thread_id: item.thread_id,
        thread_title: item.thread_title,
        board: { slug: item.board_slug, name: item.board_name },
        snippet: snippetOf(item.content, 80),
        created_at: item.created_at,
      })),
      thread_total: countThreads({ authorId: row.id }),
    };
  });

  router.get('/api/users/:id/threads', async (ctx) => {
    const row = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(ctx.params.id));
    if (!row) throw notFound('用户不存在');
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);
    const total = countThreads({ authorId: row.id });
    return {
      threads: listThreads({ authorId: row.id, limit: perPage, offset, sort: 'new' }).map((item) =>
        threadOut(item, { withSnippet: false }),
      ),
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  router.get('/api/users/:id/posts', async (ctx) => {
    const row = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(ctx.params.id));
    if (!row) throw notFound('用户不存在');
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);
    const items = listRepliesByAuthor(row.id, perPage, offset);
    const total = countRepliesByAuthor(row.id);
    return {
      posts: items.map((item) => ({
        id: item.id,
        thread_id: item.thread_id,
        thread_title: item.thread_title,
        board: { slug: item.board_slug, name: item.board_name },
        snippet: snippetOf(item.content, 120),
        created_at: item.created_at,
      })),
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });
}
