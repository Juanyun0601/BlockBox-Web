import { db, now, paginate, refreshBoardCounts, transaction } from '../db.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { muteScopeList, normalizeMuteScope, publicUser, requireAdmin, requireHeadAdmin } from '../lib/auth.js';
import { siteStats } from '../lib/queries.js';
import { visitStats } from '../lib/visits.js';
import {
  MAX_ENTRIES,
  MAX_IMPORTANT_ENTRIES,
  announcementStatus,
  listAnnouncements,
  listImportantAnnouncements,
  publishAnnouncement,
  publishImportantAnnouncement,
  removeAnnouncement,
  removeImportantAnnouncement,
  setImportantAnnouncementEnabled,
} from '../lib/announcements.js';

export default function register(router) {
  /** 到期的禁言自动恢复正常（永久禁言 muted_until 为 0，不动） */
  function sweepExpiredMutes() {
    db.prepare(
      `UPDATE users
          SET status = 'active', muted_until = 0, mute_scope = 'all', mute_reason = '', mute_by = ''
        WHERE status = 'muted' AND muted_until > 0 AND muted_until <= ?`,
    ).run(now());
  }

  router.get('/api/admin/overview', async (ctx) => {
    requireAdmin(ctx.user);
    sweepExpiredMutes();
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

  // ---------------- 访问数据 ----------------

  router.get('/api/admin/visits', async (ctx) => {
    requireAdmin(ctx.user);
    return visitStats({ days: Number(ctx.url.searchParams.get('days') || 30) });
  });

  // ---------------- 首页公告 ----------------

  /** 后台的公告列表 + 官网公告文件当前能不能写 */
  router.get('/api/admin/announcements', async (ctx) => {
    requireAdmin(ctx.user);
    return {
      announcements: listAnnouncements(),
      important: listImportantAnnouncements(),
      file: announcementStatus(),
      limit: MAX_ENTRIES,
      important_limit: MAX_IMPORTANT_ENTRIES,
    };
  });

  /** 一键发布：写进官网公告文件，启动器首页公告栏下次刷新就能看到 */
  router.post('/api/admin/announcements', async (ctx) => {
    const admin = requireAdmin(ctx.user);
    const body = await ctx.json();
    return {
      announcement: publishAnnouncement({ text: body.text, link: body.link, admin }),
      file: announcementStatus(),
      limit: MAX_ENTRIES,
    };
  });

  router.delete('/api/admin/announcements/:id', async (ctx) => {
    requireAdmin(ctx.user);
    removeAnnouncement(ctx.params.id);
    return { ok: true, file: announcementStatus(), limit: MAX_ENTRIES };
  });

  // ---------------- 启动重要公告 ----------------

  /** 发布一条启动弹窗公告（Markdown 正文），自动顶替上一条生效的公告 */
  router.post('/api/admin/important-announcements', async (ctx) => {
    const admin = requireAdmin(ctx.user);
    const body = await ctx.json();
    return {
      important: publishImportantAnnouncement({
        title: body.title,
        content: body.content,
        link: body.link,
        admin,
      }),
      file: announcementStatus(),
      limit: MAX_IMPORTANT_ENTRIES,
    };
  });

  /** 上线 / 下线：上线会顶替当前生效的那条，下线后启动器不再弹 */
  router.patch('/api/admin/important-announcements/:id', async (ctx) => {
    requireAdmin(ctx.user);
    const body = await ctx.json();
    return {
      important: setImportantAnnouncementEnabled(ctx.params.id, body.enabled !== false),
      file: announcementStatus(),
      limit: MAX_IMPORTANT_ENTRIES,
    };
  });

  router.delete('/api/admin/important-announcements/:id', async (ctx) => {
    requireAdmin(ctx.user);
    removeImportantAnnouncement(ctx.params.id);
    return { ok: true, file: announcementStatus(), limit: MAX_IMPORTANT_ENTRIES };
  });

  router.get('/api/admin/users', async (ctx) => {
    requireAdmin(ctx.user);
    sweepExpiredMutes();
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
    if (!['user', 'moderator', 'admin'].includes(role)) throw badRequest('角色只能是 user / moderator / admin');
    if (!['active', 'muted', 'banned'].includes(status)) throw badRequest('状态只能是 active / muted / banned');

    // 次级管理员什么都能做，唯独不能设置别人的管理权限
    if (role !== target.role && admin.role !== 'admin') throw forbidden('次级管理员无法设置管理权限');

    // 禁止内容：不传就沿用原来的，传了但一项都没选算错误
    let scope = target.mute_scope || 'all';
    if (body.mute_scope !== undefined) {
      if (!muteScopeList(body.mute_scope).length) throw badRequest('至少要选一项禁止内容');
      scope = normalizeMuteScope(body.mute_scope);
    }

    // 理由：留空表示不记录理由
    let reason = String(target.mute_reason || '');
    if (body.mute_reason !== undefined) {
      reason = String(body.mute_reason == null ? '' : body.mute_reason).trim().slice(0, 100);
    }

    let mutedUntil = target.muted_until || 0;
    if (body.muted_until !== undefined) {
      mutedUntil = Math.max(0, Math.floor(Number(body.muted_until) || 0));
    }
    // mute_hours：>0 从现在起算，0 表示永久（到管理员手动解除为止），不传则保留原到期时间
    if (status === 'muted' && body.mute_hours !== undefined) {
      const hours = Math.max(0, Math.min(24 * 365, Math.floor(Number(body.mute_hours) || 0)));
      mutedUntil = hours === 0 ? 0 : now() + hours * 3600;
    }
    // 从正常状态改成禁言但没给时间：默认 24 小时
    if (status === 'muted' && mutedUntil === 0 && target.status !== 'muted' && body.mute_hours === undefined) {
      mutedUntil = now() + 24 * 3600;
    }

    let muteBy = String(target.mute_by || '');
    if (status === 'muted') {
      // 只改角色时不覆盖原来的操作人
      const touchedMute =
        body.status !== undefined ||
        body.mute_scope !== undefined ||
        body.mute_reason !== undefined ||
        body.mute_hours !== undefined ||
        body.muted_until !== undefined;
      if (touchedMute) muteBy = String(admin.display_name || admin.username || '').slice(0, 40);
    } else {
      // 恢复正常 / 封禁：禁言相关的信息一并清掉
      mutedUntil = 0;
      scope = 'all';
      reason = '';
      muteBy = '';
    }

    db.prepare(
      'UPDATE users SET role = ?, status = ?, muted_until = ?, mute_scope = ?, mute_reason = ?, mute_by = ? WHERE id = ?',
    ).run(role, status, mutedUntil, scope, reason, muteBy, target.id);
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
