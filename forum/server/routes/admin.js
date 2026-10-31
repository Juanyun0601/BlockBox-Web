import { db, now, paginate, refreshBoardCounts, transaction } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { publicUser, requireAdmin } from '../lib/auth.js';
import { siteStats } from '../lib/queries.js';

export default function register(router) {
  router.get('/api/admin/overview', async (ctx) => {
    requireAdmin(ctx.user);
    const stats = siteStats();
    const boards = db.prepare('SELECT * FROM boards ORDER BY sort_order ASC, id ASC').all();
    const recentUsers = db
      .prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 10')
      .all()
      .map((row) => publicUser(row, { self: true }));
    const recentThreads = db
      .prepare(
        `SELECT t.id, t.title, t.created_at, t.deleted, b.slug AS board_slug, b.name AS board_name,
                u.username, u.display_name
           FROM threads t JOIN boards b ON b.id = t.board_id JOIN users u ON u.id = t.author_id
          ORDER BY t.created_at DESC LIMIT 10`,
      )
      .all();
    const reports = db
      .prepare(
        `SELECT p.id, p.thread_id, t.title AS thread_title, p.created_at, p.deleted,
                u.username, u.display_name
           FROM posts p JOIN threads t ON t.id = p.thread_id LEFT JOIN users u ON u.id = p.author_id
          WHERE p.deleted = 0
          ORDER BY p.created_at DESC LIMIT 10`,
      )
      .all();

    return {
      stats,
      boards: boards.map((b) => ({
        id: b.id,
        slug: b.slug,
        name: b.name,
        description: b.description,
        icon: b.icon,
        sort_order: b.sort_order,
        thread_count: b.thread_count,
        post_count: b.post_count,
      })),
      recent_users: recentUsers,
      recent_threads: recentThreads,
      recent_posts: reports,
    };
  });

  router.get('/api/admin/users', async (ctx) => {
    requireAdmin(ctx.user);
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 30);
    const q = String(ctx.url.searchParams.get('q') || '').trim();
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const where = q ? "WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'" : '';
    const params = q ? [like, like] : [];

    const total = db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(...params).n;
    const rows = db
      .prepare(`SELECT * FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, perPage, offset);

    return {
      users: rows.map((row) => publicUser(row, { self: true })),
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  router.patch('/api/admin/users/:id', async (ctx) => {
    const admin = requireAdmin(ctx.user);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(ctx.params.id));
    if (!target) throw notFound('用户不存在');
    if (target.id === admin.id) throw badRequest('不能修改自己的管理权限');

    const body = await ctx.json();
    const role = body.role === undefined ? target.role : String(body.role);
    const status = body.status === undefined ? target.status : String(body.status);
    if (!['user', 'admin'].includes(role)) throw badRequest('角色只能是 user 或 admin');
    if (!['active', 'muted', 'banned'].includes(status)) throw badRequest('状态只能是 active / muted / banned');

    let mutedUntil = target.muted_until;
    if (body.muted_until !== undefined) {
      mutedUntil = Math.max(0, Math.floor(Number(body.muted_until) || 0));
    }
    if (status === 'muted' && mutedUntil === 0) {
      const hours = Number(body.mute_hours ?? 24);
      mutedUntil = now() + Math.max(1, Math.min(24 * 365, Math.floor(hours))) * 3600;
    }
    if (status !== 'muted') mutedUntil = 0;

    db.prepare('UPDATE users SET role = ?, status = ?, muted_until = ? WHERE id = ?').run(
      role,
      status,
      mutedUntil,
      target.id,
    );
    if (status === 'banned') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);

    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id), { self: true }) };
  });

  router.post('/api/admin/rescan', async (ctx) => {    requireAdmin(ctx.user);
    const boards = db.prepare('SELECT id FROM boards').all();
    transaction(() => {
      for (const board of boards) refreshBoardCounts(board.id);
      db.prepare('UPDATE users SET post_count = (SELECT COUNT(*) FROM posts WHERE author_id = users.id AND deleted = 0), thread_count = (SELECT COUNT(*) FROM threads WHERE author_id = users.id AND deleted = 0)').run();
    });
    return { ok: true, boards: boards.length };
  });

  // ---------------- 标签管理 ----------------

  const normalizeTag = (value) =>
    String(value == null ? '' : value)
      .trim()
      .replace(/^#+/, '')
      .replace(/[,，、\s]+/g, '')
      .slice(0, 12);

  router.get('/api/admin/tags', async (ctx) => {
    requireAdmin(ctx.user);
    const rows = db
      .prepare(
        `SELECT tt.tag, COUNT(*) AS n
           FROM thread_tags tt
           JOIN threads t ON t.id = tt.thread_id
          WHERE t.deleted = 0
          GROUP BY tt.tag
          ORDER BY n DESC, tt.tag ASC
          LIMIT 300`,
      )
      .all();
    const featured = db.prepare('SELECT tag, sort_order FROM tag_features ORDER BY sort_order ASC').all();
    const featuredMap = new Map(featured.map((item) => [item.tag, item.sort_order]));

    return {
      tags: rows.map((row) => ({
        tag: row.tag,
        count: row.n,
        featured: featuredMap.has(row.tag),
        sort_order: featuredMap.has(row.tag) ? featuredMap.get(row.tag) : null,
      })),
      featured: featured.map((item) => item.tag),
    };
  });

  router.post('/api/admin/tags/feature', async (ctx) => {
    requireAdmin(ctx.user);
    const body = await ctx.json();
    const tag = normalizeTag(body.tag);
    if (!tag) throw badRequest('标签名不能为空');
    const featured = !!body.featured;
    if (featured) {
      const sortOrder = Number.isFinite(Number(body.sort_order)) ? Math.floor(Number(body.sort_order)) : 0;
      db.prepare(
        'INSERT INTO tag_features (tag, sort_order, created_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(tag) DO UPDATE SET sort_order = excluded.sort_order',
      ).run(tag, sortOrder, now());
    } else {
      db.prepare('DELETE FROM tag_features WHERE tag = ?').run(tag);
    }
    return { ok: true, tag, featured };
  });

  router.post('/api/admin/tags/merge', async (ctx) => {
    requireAdmin(ctx.user);
    const body = await ctx.json();
    const sources = (Array.isArray(body.from) ? body.from : [body.from]).map(normalizeTag).filter(Boolean);
    const target = normalizeTag(body.to);
    if (sources.length === 0) throw badRequest('请选择要合并的标签');
    if (!target) throw badRequest('合并后的标签名不能为空');

    const placeholders = sources.map(() => '?').join(',');
    const threadIds = db
      .prepare(`SELECT DISTINCT thread_id FROM thread_tags WHERE tag IN (${placeholders})`)
      .all(...sources)
      .map((row) => row.thread_id);

    transaction(() => {
      const insert = db.prepare('INSERT OR IGNORE INTO thread_tags (thread_id, tag) VALUES (?, ?)');
      for (const threadId of threadIds) insert.run(threadId, target);
      db.prepare(`DELETE FROM thread_tags WHERE tag IN (${placeholders}) AND tag != ?`).run(...sources, target);
      for (const tag of sources) {
        if (tag === target) continue;
        db.prepare('UPDATE OR IGNORE tag_features SET tag = ? WHERE tag = ?').run(target, tag);
        db.prepare('DELETE FROM tag_features WHERE tag = ?').run(tag);
      }
    });

    return { ok: true, into: target, merged: sources, threads: threadIds.length };
  });

  router.post('/api/admin/tags/delete', async (ctx) => {
    requireAdmin(ctx.user);
    const body = await ctx.json();
    const tag = normalizeTag(body.tag);
    if (!tag) throw badRequest('标签名不能为空');
    const removed = db.prepare('DELETE FROM thread_tags WHERE tag = ?').run(tag).changes;
    db.prepare('DELETE FROM tag_features WHERE tag = ?').run(tag);
    return { ok: true, tag, removed };
  });
}
