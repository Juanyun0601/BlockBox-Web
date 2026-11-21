import { db, now, paginate } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { isAdminRole, publicUser, requireUser } from '../lib/auth.js';
import { enforce } from '../lib/rate-limit.js';
import {
  countFollowers,
  countFollowing,
  friendshipBetween,
  isFollowing,
  listFollowUsers,
} from '../lib/social.js';
import { int } from '../lib/validate.js';
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
      /** 我是否关注了 TA（未登录恒为 false） */
      following: !self && ctx.user ? isFollowing(ctx.user.id, row.id) : false,
      follower_count: countFollowers(row.id),
      following_count: countFollowing(row.id),
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

  // ---------------- 关注 ----------------
  // 关注是单向的，不需要对方同意；和好友（要双方同意、可私信）是两套关系。

  /** 关注 / 取关的目标：存在且未封禁，并且不是自己 */
  function followTarget(rawId, meId) {
    const id = int(rawId, { field: '用户' });
    const row = db.prepare('SELECT id, status FROM users WHERE id = ?').get(id);
    if (!row || row.status === 'banned') throw notFound('用户不存在');
    if (row.id === meId) throw badRequest('不能关注自己');
    return row;
  }

  router.post('/api/users/:id/follow', async (ctx) => {
    const user = requireUser(ctx.user);
    const target = followTarget(ctx.params.id, user.id);
    // 关注 / 取关来回点也算操作，挡一下脚本刷数量
    enforce(`follow:${user.id}`, 120, 60 * 60 * 1000, '关注操作太频繁');
    db.prepare(
      `INSERT OR IGNORE INTO user_follows (follower_id, following_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(user.id, target.id, now());
    return {
      ok: true,
      following: true,
      follower_count: countFollowers(target.id),
      following_count: countFollowing(user.id),
    };
  });

  router.delete('/api/users/:id/follow', async (ctx) => {
    const user = requireUser(ctx.user);
    const target = followTarget(ctx.params.id, user.id);
    db.prepare('DELETE FROM user_follows WHERE follower_id = ? AND following_id = ?').run(
      user.id,
      target.id,
    );
    return {
      ok: true,
      following: false,
      follower_count: countFollowers(target.id),
      following_count: countFollowing(user.id),
    };
  });

  /** 关注 / 粉丝名单的公共校验与分页 */
  function followPage(ctx, direction) {
    const id = int(ctx.params.id, { field: '用户' });
    const row = db.prepare('SELECT id, status FROM users WHERE id = ?').get(id);
    if (!row) throw notFound('用户不存在');
    if (row.status === 'banned' && !isAdminRole(ctx.user?.role) && ctx.user?.id !== row.id) {
      throw notFound('用户不存在');
    }
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);
    const users = listFollowUsers(id, direction, ctx.user?.id || 0, perPage, offset);
    const total =
      direction === 'followers' ? countFollowers(id) : countFollowing(id);
    return {
      users,
      pagination: {
        page,
        per_page: perPage,
        total,
        pages: Math.max(1, Math.ceil(total / perPage)),
      },
    };
  }

  router.get('/api/users/:id/followers', async (ctx) => followPage(ctx, 'followers'));

  router.get('/api/users/:id/following', async (ctx) => followPage(ctx, 'following'));

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
