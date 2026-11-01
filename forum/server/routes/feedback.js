import { db, now, paginate } from '../db.js';
import { notFound } from '../lib/http.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { enforce } from '../lib/rate-limit.js';
import { text } from '../lib/validate.js';

const FEEDBACK_SOURCES = ['web', 'launcher'];

export default function register(router) {
  // ---------------- 用户反馈（官网 / 论坛 / 启动器共用） ----------------

  /** 提交反馈：登录用户每账号每小时限 5 条，来源标记 web（网页）或 launcher（启动器） */
  router.post('/api/feedback', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`feedback:${user.id}`, 5, 60 * 60 * 1000, '反馈提交太频繁，请稍后再试');

    const body = await ctx.json();
    const content = text(body.content, { field: '反馈内容', min: 5, max: 1000 });
    const source = FEEDBACK_SOURCES.includes(String(body.source)) ? String(body.source) : 'web';
    const appVersion = text(body.app_version, { field: '软件版本', max: 40, optional: true }) || '';

    const info = db
      .prepare(
        `INSERT INTO feedbacks (user_id, source, content, app_version, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(user.id, source, content, appVersion, now());
    return { ok: true, id: Number(info.lastInsertRowid) };
  });

  /** 我的反馈列表（含处理状态与管理员回复） */
  router.get('/api/me/feedbacks', async (ctx) => {
    const user = requireUser(ctx.user);
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);

    const total = db.prepare('SELECT COUNT(*) AS n FROM feedbacks WHERE user_id = ?').get(user.id).n;
    const rows = db
      .prepare(
        `SELECT id, source, content, app_version, status, reply, handled_at, created_at
           FROM feedbacks
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(user.id, perPage, offset);

    return {
      feedbacks: rows,
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  // ---------------- 管理：反馈处理 ----------------

  router.get('/api/admin/feedbacks', async (ctx) => {
    requireAdmin(ctx.user);
    const statusParam = ctx.url.searchParams.get('status') || 'open';
    const status = ['open', 'resolved', 'ignored', 'all'].includes(statusParam) ? statusParam : 'open';
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);
    const where = status === 'all' ? '' : 'WHERE f.status = ?';
    const params = status === 'all' ? [] : [status];

    const total = db.prepare(`SELECT COUNT(*) AS n FROM feedbacks f ${where}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT f.id, f.source, f.content, f.app_version, f.status, f.reply,
                f.handled_by, f.handled_at, f.created_at,
                u.id AS user_id, u.username AS user_username, u.display_name AS user_display_name,
                a.username AS handled_by_name
           FROM feedbacks f
           LEFT JOIN users u ON u.id = f.user_id
           LEFT JOIN users a ON a.id = f.handled_by
           ${where}
          ORDER BY f.created_at DESC, f.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, perPage, offset);

    return {
      status,
      feedbacks: rows.map((row) => ({
        id: row.id,
        source: row.source,
        content: row.content,
        app_version: row.app_version,
        status: row.status,
        reply: row.reply,
        handled_at: row.handled_at,
        handled_by: row.handled_by_name || '',
        created_at: row.created_at,
        user: row.user_id
          ? { id: row.user_id, username: row.user_username, display_name: row.user_display_name || row.user_username }
          : null,
      })),
      counts: {
        open: db.prepare("SELECT COUNT(*) AS n FROM feedbacks WHERE status = 'open'").get().n,
        resolved: db.prepare("SELECT COUNT(*) AS n FROM feedbacks WHERE status = 'resolved'").get().n,
        ignored: db.prepare("SELECT COUNT(*) AS n FROM feedbacks WHERE status = 'ignored'").get().n,
      },
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  router.patch('/api/admin/feedbacks/:id', async (ctx) => {
    const admin = requireAdmin(ctx.user);
    const feedback = db.prepare('SELECT * FROM feedbacks WHERE id = ?').get(Number(ctx.params.id));
    if (!feedback) throw notFound('反馈记录不存在');

    const body = await ctx.json();
    const status = ['resolved', 'ignored', 'open'].includes(String(body.status)) ? String(body.status) : 'resolved';
    const reply = text(body.reply, { field: '回复内容', max: 500, optional: true }) || '';

    db.prepare('UPDATE feedbacks SET status = ?, reply = ?, handled_by = ?, handled_at = ? WHERE id = ?').run(
      status,
      reply,
      status === 'open' ? null : admin.id,
      status === 'open' ? 0 : now(),
      feedback.id,
    );
    return { ok: true, status };
  });
}
