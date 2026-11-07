import { db, now, paginate } from '../db.js';
import { badRequest, notFound, readRawBody } from '../lib/http.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { enforce } from '../lib/rate-limit.js';
import { saveImage, removeUpload } from '../lib/images.js';
import { savePluginPackage } from '../lib/plugins.js';
import { config } from '../config.js';
import { markAllRead, markRead, unreadNotifications } from '../lib/notify.js';
import { snippetOf } from '../lib/serialize.js';
import { text } from '../lib/validate.js';

export default function register(router) {
  // ---------------- 站内图床 ----------------

  router.post('/api/upload', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`upload:${user.id}`, 40, 60 * 60 * 1000, '上传太频繁');

    const buffer = await readRawBody(ctx.req, config.maxImageBytes);
    const saved = await saveImage(buffer, { userId: user.id, kind: 'img' });
    return saved;
  });

  // ---------------- 插件帖：上传插件包 ----------------
  // 只收真实发帖人上传的 .BlockBox（zip），清单以服务端解包为准。
  // 绑定帖子在 POST /api/threads（带 plugin_upload_id）时完成，一帖一个。

  router.post('/api/upload/plugin', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`upload-plugin:${user.id}`, 10, 60 * 60 * 1000, '插件上传太频繁');

    const buffer = await readRawBody(ctx.req, config.maxPluginBytes);
    return savePluginPackage(buffer, { userId: user.id });
  });

  // ---------------- 我的相册 ----------------

  router.get('/api/me/uploads', async (ctx) => {
    const user = requireUser(ctx.user);
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 24);
    const rows = db
      .prepare(
        `SELECT id, url, thumb, mime, width, height, size, kind, created_at
           FROM uploads
          WHERE user_id = ? AND deleted = 0
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(user.id, perPage, offset);
    const total = db
      .prepare('SELECT COUNT(*) AS n FROM uploads WHERE user_id = ? AND deleted = 0')
      .get(user.id).n;

    return {
      uploads: rows,
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  router.delete('/api/me/uploads/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const row = db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), user.id);
    if (!row || row.deleted) throw notFound('图片不存在');
    db.prepare('UPDATE uploads SET deleted = 1 WHERE id = ?').run(row.id);
    removeUpload(row.url);
    return { ok: true };
  });

  // ---------------- 举报 ----------------

  router.post('/api/reports', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`report:${user.id}`, 10, 60 * 60 * 1000, '举报太频繁');

    const body = await ctx.json();
    const postId = Number(body.post_id);
    if (!Number.isInteger(postId) || postId <= 0) throw badRequest('缺少要举报的楼层');

    const post = db.prepare('SELECT id, thread_id, author_id, deleted FROM posts WHERE id = ?').get(postId);
    if (!post || post.deleted) throw notFound('楼层不存在');
    if (post.author_id === user.id) throw badRequest('不用举报自己');

    const reason = text(body.reason, { field: '举报理由', max: 200, optional: true });
    const existing = db
      .prepare('SELECT id, status FROM reports WHERE post_id = ? AND reporter_id = ?')
      .get(postId, user.id);
    if (existing) {
      if (existing.status === 'open') return { ok: true, duplicated: true };
      db.prepare('UPDATE reports SET status = ?, reason = ?, created_at = ? WHERE id = ?').run(
        'open',
        reason,
        now(),
        existing.id,
      );
      return { ok: true, duplicated: true };
    }

    db.prepare(
      `INSERT INTO reports (post_id, thread_id, reporter_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(postId, post.thread_id, user.id, reason, now());
    return { ok: true };
  });

  // ---------------- 通知 ----------------

  /**
   * 通知列表：先把同一主题、同一类型（回复主题 / 回复我的楼层 / @ 我）的通知折叠成一条，
   * 再对折叠后的条目分页。这样一个人连回三句只会占一行。
   */
  router.get('/api/notifications', async (ctx) => {
    const user = requireUser(ctx.user);
    const { page, perPage } = paginate(ctx.url.searchParams, 20);

    const rows = db
      .prepare(
        `SELECT n.id, n.type, n.target_kind, n.thread_id, n.post_id, n.thread_title,
                n.excerpt, n.read_at, n.created_at,
                u.id AS actor_id, u.username AS actor_username,
                u.display_name AS actor_display_name, u.avatar AS actor_avatar
           FROM notifications n
           LEFT JOIN users u ON u.id = n.actor_id
          WHERE n.user_id = ?
          ORDER BY n.created_at DESC, n.id DESC
          LIMIT 500`,
      )
      .all(user.id);

    const groups = new Map();
    for (const row of rows) {
      const key = `${row.type}|${row.target_kind}|${row.thread_id}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          id: row.id,
          type: row.type,
          target_kind: row.target_kind,
          thread_id: row.thread_id,
          post_id: row.post_id,
          thread_title: row.thread_title,
          excerpt: row.excerpt,
          created_at: row.created_at,
          ids: [],
          actorCount: 0,
          actorIds: new Set(),
          actors: [],
          unread: 0,
          count: 0,
        };
        groups.set(key, group);
      }
      group.ids.push(row.id);
      group.count += 1;
      if (!row.read_at) group.unread += 1;
      if (row.actor_id) {
        group.actorIds.add(row.actor_id);
        if (group.actors.length < 3 && !group.actors.some((actor) => actor.id === row.actor_id)) {
          group.actors.push({
            id: row.actor_id,
            username: row.actor_username,
            display_name: row.actor_display_name || row.actor_username,
            avatar: row.actor_avatar || '',
          });
        }
      }
    }

    for (const group of groups.values()) group.actorCount = group.actorIds.size;

    const items = [...groups.values()];
    const total = items.length;
    const start = (page - 1) * perPage;

    return {
      items: items.slice(start, start + perPage).map((group) => ({
        id: group.id,
        type: group.type,
        target_kind: group.target_kind,
        thread_id: group.thread_id,
        post_id: group.post_id,
        thread_title: group.thread_title,
        excerpt: group.excerpt,
        created_at: group.created_at,
        count: group.count,
        actor_count: group.actorCount,
        actors: group.actors,
        ids: group.ids,
        unread: group.unread > 0,
        unread_count: group.unread,
      })),
      unread: unreadNotifications(user.id),
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  router.post('/api/notifications/read', async (ctx) => {
    const user = requireUser(ctx.user);
    const body = await ctx.json();
    const changed = Array.isArray(body.ids) && body.ids.length > 0 ? markRead(user.id, body.ids) : markAllRead(user.id);
    return { ok: true, changed, unread: unreadNotifications(user.id) };
  });

  router.delete('/api/notifications/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(Number(ctx.params.id), user.id);
    return { ok: true, unread: unreadNotifications(user.id) };
  });

  // ---------------- 管理：审核队列 ----------------

  router.get('/api/admin/reports', async (ctx) => {
    requireAdmin(ctx.user);
    const status = ['open', 'resolved', 'ignored'].includes(ctx.url.searchParams.get('status') || '')
      ? ctx.url.searchParams.get('status')
      : 'open';

    const rows = db
      .prepare(
        `SELECT r.id, r.post_id, r.thread_id, r.reason, r.status, r.created_at, r.handled_at,
                p.floor, p.content, p.deleted,
                t.title AS thread_title, t.deleted AS thread_deleted,
                a.id AS author_id, a.username AS author_username, a.display_name AS author_display_name,
                rp.id AS reporter_id, rp.username AS reporter_username
           FROM reports r
           LEFT JOIN posts p ON p.id = r.post_id
           LEFT JOIN threads t ON t.id = r.thread_id
           LEFT JOIN users a ON a.id = p.author_id
           LEFT JOIN users rp ON rp.id = r.reporter_id
          WHERE r.status = ?
          ORDER BY r.created_at DESC
          LIMIT 100`,
      )
      .all(status);

    return {
      status,
      reports: rows.map((row) => ({
        id: row.id,
        post_id: row.post_id,
        thread_id: row.thread_id,
        floor: row.floor,
        reason: row.reason,
        status: row.status,
        created_at: row.created_at,
        handled_at: row.handled_at,
        thread_title: row.thread_title,
        thread_deleted: !!row.thread_deleted,
        post_deleted: !!row.deleted,
        excerpt: row.content ? snippetOf(row.content, 140) : '',
        author: row.author_id
          ? { id: row.author_id, username: row.author_username, display_name: row.author_display_name || row.author_username }
          : null,
        reporter: { id: row.reporter_id, username: row.reporter_username },
      })),
      counts: {
        open: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n,
        resolved: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'resolved'").get().n,
      },
    };
  });

  router.patch('/api/admin/reports/:id', async (ctx) => {
    const admin = requireAdmin(ctx.user);
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(ctx.params.id));
    if (!report) throw notFound('举报记录不存在');

    const body = await ctx.json();
    const status = ['resolved', 'ignored', 'open'].includes(String(body.status)) ? String(body.status) : 'resolved';

    if (body.delete_post) {
      db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?').run(report.post_id);
      db.prepare('UPDATE threads SET reply_count = MAX(0, reply_count - 1) WHERE id = ?').run(report.thread_id);
      db.prepare('DELETE FROM notifications WHERE post_id = ?').run(report.post_id);
      const thread = db.prepare('SELECT board_id FROM threads WHERE id = ?').get(report.thread_id);
      if (thread) {
        db.prepare(
          `UPDATE boards SET
             post_count = (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id
                            WHERE t.board_id = boards.id AND t.deleted = 0 AND p.deleted = 0)
           WHERE id = ?`,
        ).run(thread.board_id);
      }
    }

    db.prepare('UPDATE reports SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?').run(
      status,
      admin.id,
      now(),
      report.id,
    );
    return { ok: true, status };
  });
}
