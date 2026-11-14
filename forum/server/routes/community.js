import { db, now, paginate } from '../db.js';
import { badRequest, notFound, readRawBody } from '../lib/http.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { enforce } from '../lib/rate-limit.js';
import { saveImage, removeUpload } from '../lib/images.js';
import { saveChatFile } from '../lib/chat-files.js';
import { saveLogFile } from '../lib/log-files.js';
import { savePluginPackage } from '../lib/plugins.js';
import { saveSchematicFile } from '../lib/schematics.js';
import { config } from '../config.js';
import { markAllRead, markRead, notifyAdminMessage, unreadNotifications } from '../lib/notify.js';
import { snippetOf } from '../lib/serialize.js';
import { text } from '../lib/validate.js';

/** 举报分类白名单：与客户端举报页的 8 个分类保持一致，新增时两边同步 */
const REPORT_CATEGORIES = [
  'spam',
  'insult',
  'porn',
  'illegal',
  'infringe',
  'privacy',
  'flooding',
  'other',
];

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

  // ---------------- 投影帖：上传投影文件 ----------------
  // 原始文件名从 X-File-Name 头带过来（聊天上传同款约定），服务端只做白名单校验：
  // 扩展名、文件头、大小。投影内容由启动器本地解析，服务端不解读。

  router.post('/api/upload/schematic', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`upload-schematic:${user.id}`, 10, 60 * 60 * 1000, '投影上传太频繁');

    const fileName = decodeURIComponent((ctx.req.headers['x-file-name'] || '').toString());
    const buffer = await readRawBody(ctx.req, config.maxSchematicBytes);
    return saveSchematicFile(buffer, { userId: user.id, fileName });
  });

  // ---------------- 聊天附件：私聊 / 群聊发文件 ----------------
  // 客户端先 POST 这里拿到 { url, name, size }，再把 url 放进消息里发出去。

  router.post('/api/upload/chat', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`upload-chat:${user.id}`, 20, 60 * 60 * 1000, '文件发得太频繁');

    const name = decodeURIComponent((ctx.req.headers['x-file-name'] || '').toString());
    const buffer = await readRawBody(ctx.req, config.maxChatFileBytes);
    return saveChatFile(buffer, { userId: user.id, originalName: name });
  });

  // ---------------- 反馈日志：问题反馈页「一键上传日志」 ----------------
  // 启动器把导出的运行日志整份传上来，拿站内链接填进反馈的「日志」栏，
  // 管理员处理时点链接就能看到完整日志，不用让用户自己挑行复制。

  router.post('/api/upload/log', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`upload-log:${user.id}`, 10, 60 * 60 * 1000, '日志上传太频繁');

    const name = decodeURIComponent((ctx.req.headers['x-file-name'] || '').toString());
    const version = decodeURIComponent((ctx.req.headers['x-app-version'] || '').toString());
    const buffer = await readRawBody(ctx.req, config.maxLogBytes);
    return saveLogFile(buffer, { userId: user.id, originalName: name, appVersion: version });
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

    const category = REPORT_CATEGORIES.includes(String(body.category || ''))
      ? String(body.category)
      : '';
    const reason = text(body.reason, { field: '举报理由', max: 200, optional: true });
    const existing = db
      .prepare('SELECT id, status FROM reports WHERE post_id = ? AND reporter_id = ?')
      .get(postId, user.id);
    if (existing) {
      if (existing.status === 'open') return { ok: true, duplicated: true };
      db.prepare('UPDATE reports SET status = ?, category = ?, reason = ?, created_at = ? WHERE id = ?').run(
        'open',
        category,
        reason,
        now(),
        existing.id,
      );
      return { ok: true, duplicated: true };
    }

    db.prepare(
      `INSERT INTO reports (post_id, thread_id, reporter_id, category, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(postId, post.thread_id, user.id, category, reason, now());
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
      // 系统通知（管理员回复等）每条独立一行，不参与折叠
      const key =
        row.type === 'system'
          ? `${row.type}|${row.target_kind}|${row.id}`
          : `${row.type}|${row.target_kind}|${row.thread_id}`;
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

    const postRows = db
      .prepare(
        `SELECT r.id, r.post_id, r.thread_id, r.category, r.reason, r.status, r.created_at, r.handled_at,
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

    // 资源帖评论的举报也存在同一个审核队列里（两套表，对外合并成一份列表）
    const commentRows = db
      .prepare(
        `SELECT cr.id, cr.comment_id, cr.thread_id, cr.category, cr.reason, cr.status, cr.created_at, cr.handled_at,
                c.content, c.deleted,
                t.title AS thread_title, t.deleted AS thread_deleted,
                a.id AS author_id, a.username AS author_username, a.display_name AS author_display_name,
                rp.id AS reporter_id, rp.username AS reporter_username
           FROM comment_reports cr
           LEFT JOIN thread_comments c ON c.id = cr.comment_id
           LEFT JOIN threads t ON t.id = cr.thread_id
           LEFT JOIN users a ON a.id = c.author_id
           LEFT JOIN users rp ON rp.id = cr.reporter_id
          WHERE cr.status = ?
          ORDER BY cr.created_at DESC
          LIMIT 100`,
      )
      .all(status);

    const rows = [
      ...postRows.map((row) => ({ ...row, kind: 'post' })),
      ...commentRows.map((row) => ({ ...row, kind: 'comment', post_id: null, floor: null })),
    ]
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .slice(0, 100);

    return {
      status,
      reports: rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        post_id: row.post_id,
        comment_id: row.comment_id || null,
        thread_id: row.thread_id,
        floor: row.floor,
        category: row.category,
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
        open:
          db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n +
          db.prepare("SELECT COUNT(*) AS n FROM comment_reports WHERE status = 'open'").get().n,
        resolved:
          db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'resolved'").get().n +
          db.prepare("SELECT COUNT(*) AS n FROM comment_reports WHERE status = 'resolved'").get().n,
      },
    };
  });

  router.patch('/api/admin/reports/:id', async (ctx) => {
    const admin = requireAdmin(ctx.user);
    const body = await ctx.json();
    const status = ['resolved', 'ignored', 'open'].includes(String(body.status)) ? String(body.status) : 'resolved';

    // 评论举报走另一张表，id 空间互不相干，靠 kind 区分
    if (String(body.kind || '') === 'comment') {
      const report = db.prepare('SELECT * FROM comment_reports WHERE id = ?').get(Number(ctx.params.id));
      if (!report) throw notFound('举报记录不存在');

      if (body.delete_post && report.comment_id) {
        db.prepare('UPDATE thread_comments SET deleted = 1, updated_at = ? WHERE id = ?').run(now(), report.comment_id);
      }
      db.prepare('UPDATE comment_reports SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?').run(
        status,
        admin.id,
        now(),
        report.id,
      );
      if (report.reporter_id && status !== 'open') {
        const notice =
          status === 'resolved'
            ? body.delete_post
              ? ['您举报的评论已删除', '您举报的评论已被管理员删除，感谢您对社区环境的维护。']
              : ['您举报的内容已处理', '您举报的内容已处理，感谢您的反馈。']
            : ['您的举报已收到', '感谢您的举报，管理员核查后暂未对相关内容采取措施。'];
        notifyAdminMessage(report.reporter_id, notice[0], notice[1]);
      }
      return { ok: true, status };
    }

    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(ctx.params.id));
    if (!report) throw notFound('举报记录不存在');

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

    // 处理完自动回告举报人（重新打开不发）；reporter_id 可能因注销为空
    if (report.reporter_id && status !== 'open') {
      const notice =
        status === 'resolved'
          ? body.delete_post
            ? ['您举报的楼层已删除', '您举报的楼层已被管理员删除，感谢您对社区环境的维护。']
            : ['您举报的内容已处理', '您举报的内容已处理，感谢您的反馈。']
          : ['您的举报已收到', '感谢您的举报，管理员核查后暂未对相关内容采取措施。'];
      notifyAdminMessage(report.reporter_id, notice[0], notice[1]);
    }
    return { ok: true, status };
  });
}
