import { db, now, paginate } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { enforce } from '../lib/rate-limit.js';
import { text } from '../lib/validate.js';

const FEEDBACK_SOURCES = ['web', 'launcher'];
const FEEDBACK_TYPES = ['bug', 'feature'];
// 与仓库 .github/ISSUE_TEMPLATE/bug_report.yml 的「运行平台」下拉保持一致
const FEEDBACK_PLATFORMS = ['Windows（x64）', 'Windows（ARM64）', 'Android', '鸿蒙 HarmonyOS', '其他'];

/**
 * 按类型把结构化字段组装成一条反馈正文。
 * 问题反馈的标题层级与 GitHub Issue 模板（bug_report.yml）一致（### 启动器版本 …），
 * 空着的选填项不输出；功能建议仓库没有对应模板，沿用「建议内容 + 使用场景」。
 */
function assembleContent(type, fields) {
  const sections = [];
  const push = (title, body) => sections.push(`### ${title}\n${body}`);

  if (type === 'feature') {
    push('建议内容', fields.description);
    if (fields.scene) push('使用场景', fields.scene);
    return sections.join('\n\n');
  }

  push('启动器版本', fields.appVersion);
  push('运行平台', fields.platform);
  if (fields.osVersion) push('系统版本', fields.osVersion);
  push('问题描述', fields.description);
  push('复现步骤', fields.steps);
  if (fields.expected) push('期望结果', fields.expected);
  if (fields.actual) push('实际结果', fields.actual);
  if (fields.logs) push('日志', fields.logs);
  if (fields.screenshots) push('截图 / 录屏', fields.screenshots);
  return sections.join('\n\n');
}

/** 从组装好的正文里取第一行「问题描述 / 建议内容」当列表标题（GitHub Issues 列表的样子） */
function deriveTitle(content) {
  const match = content.match(/^### (?:问题描述|建议内容)\n(.+)$/m);
  const line = (match ? match[1] : content.split('\n').find((l) => l.trim() && !l.startsWith('### ')) || '').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export default function register(router) {
  // ---------------- 用户反馈（官网 / 论坛 / 启动器共用） ----------------

  /**
   * 提交反馈：登录用户每账号每小时限 5 条，来源标记 web（网页）或 launcher（启动器）。
   * 结构化必填字段由服务端校验并组装成正文，老客户端直接传 content 的写法仍然兼容。
   */
  router.post('/api/feedback', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`feedback:${user.id}`, 5, 60 * 60 * 1000, '反馈提交太频繁，请稍后再试');

    const body = await ctx.json();
    const source = FEEDBACK_SOURCES.includes(String(body.source)) ? String(body.source) : 'web';

    // 老客户端兼容：直接给整段 content
    if (body.description === undefined && body.content !== undefined) {
      const content = text(body.content, { field: '反馈内容', min: 5, max: 1000 });
      const type = FEEDBACK_TYPES.includes(String(body.type)) ? String(body.type) : 'bug';
      const appVersion = text(body.app_version, { field: '软件版本', max: 40, optional: true }) || '';
      const info = db
        .prepare(
          `INSERT INTO feedbacks (user_id, type, source, content, app_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(user.id, type, source, content, appVersion, now());
      return { ok: true, id: Number(info.lastInsertRowid) };
    }

    const type = FEEDBACK_TYPES.includes(String(body.type)) ? String(body.type) : 'bug';

    if (type === 'feature') {
      const fields = {
        description: text(body.description, { field: '建议内容', min: 5, max: 800 }),
        scene: text(body.scene, { field: '使用场景', max: 800, optional: true }) || '',
      };
      const appVersion = text(body.app_version, { field: '软件版本', max: 40, optional: true }) || '';
      const content = assembleContent(type, fields);
      const info = db
        .prepare(
          `INSERT INTO feedbacks (user_id, type, source, content, app_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(user.id, type, source, content, appVersion, now());
      return { ok: true, id: Number(info.lastInsertRowid) };
    }

    // 问题反馈：字段与 GitHub Issue 模板一致
    const appVersion = text(body.app_version, { field: '启动器版本', min: 1, max: 40 });
    const platform = FEEDBACK_PLATFORMS.includes(String(body.platform)) ? String(body.platform) : null;
    if (!platform) throw badRequest('请选择运行平台');
    const fields = {
      appVersion,
      platform,
      osVersion: text(body.os_version, { field: '系统版本', max: 100, optional: true }) || '',
      description: text(body.description, { field: '问题描述', min: 5, max: 800 }),
      steps: text(body.steps, { field: '复现步骤', min: 2, max: 800 }),
      expected: text(body.expected, { field: '期望结果', max: 400, optional: true }) || '',
      actual: text(body.actual, { field: '实际结果', max: 400, optional: true }) || '',
      logs: text(body.logs, { field: '日志', max: 2000, optional: true }) || '',
      screenshots: text(body.screenshots, { field: '截图 / 录屏', max: 500, optional: true }) || '',
    };

    const content = assembleContent(type, fields);
    const info = db
      .prepare(
        `INSERT INTO feedbacks (user_id, type, source, content, app_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(user.id, type, source, content, appVersion, now());
    return { ok: true, id: Number(info.lastInsertRowid) };
  });

  /** 我的反馈列表（含类型、处理状态与管理员回复） */
  router.get('/api/me/feedbacks', async (ctx) => {
    const user = requireUser(ctx.user);
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);

    const total = db.prepare('SELECT COUNT(*) AS n FROM feedbacks WHERE user_id = ?').get(user.id).n;
    const rows = db
      .prepare(
        `SELECT id, type, source, content, app_version, status, reply, handled_at, created_at
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

  /** 公开反馈列表（仿 GitHub Issues 列表页：任何人可看，带状态筛选与计数） */
  router.get('/api/feedbacks', async (ctx) => {
    const statusParam = ctx.url.searchParams.get('status') || 'all';
    const status = ['open', 'resolved', 'ignored', 'all'].includes(statusParam) ? statusParam : 'all';
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);
    const where = status === 'all' ? '' : 'WHERE f.status = ?';
    const params = status === 'all' ? [] : [status];

    const total = db.prepare(`SELECT COUNT(*) AS n FROM feedbacks f ${where}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT f.id, f.type, f.status, f.content, f.reply, f.handled_at, f.created_at,
                u.id AS user_id, u.username AS user_username, u.display_name AS user_display_name
           FROM feedbacks f
           LEFT JOIN users u ON u.id = f.user_id
           ${where}
          ORDER BY f.created_at DESC, f.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, perPage, offset);

    return {
      status,
      feedbacks: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        title: deriveTitle(row.content),
        content: row.content,
        reply: row.reply,
        handled_at: row.handled_at,
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
        `SELECT f.id, f.type, f.source, f.content, f.app_version, f.status, f.reply,
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
        type: row.type,
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
