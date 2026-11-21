/**
 * 内容翻译：启动器在线详情页（CurseForge / Modrinth）的「创建翻译 / 完善翻译」。
 *
 * 用户把资源的简介和详细信息翻成中文提交，先进审核（pending），管理员通过后
 * （approved）对所有人公开，打开同一个详情页时翻译条自动显示这条人工翻译；
 * 驳回（rejected）附带理由通知作者，改完可以再交。
 * 每次提交都是一条新记录，公开展示取「最近一条审核通过的」，自己的记录另存一份
 * 供「完善翻译」预填。启动器界面目前只有中文，目标语言先固定 zh-CN。
 */
import { db, now } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { requireUser, requireAdmin } from '../lib/auth.js';
import { notifyAdminMessage } from '../lib/notify.js';
import { enforce } from '../lib/rate-limit.js';
import { text } from '../lib/validate.js';
import { guardBannedWords } from '../lib/banned-words.js';

const SOURCES = ['curseforge', 'modrinth'];
/** 支持的目标语言：服务端按这里放行，启动器加新语言时两边同步 */
const LANGS = ['zh-CN'];
const REVIEW_STATUSES = ['approved', 'rejected'];

/** 详细信息是富文本 HTML，违禁词检查先把标签剥掉，免得英文标签误伤 */
function stripHtmlTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ');
}

/** 查询参数里的 source / project_id / lang，缺了或不对就报错 */
function lookupParams(searchParams) {
  const source = String(searchParams.get('source') || '');
  if (!SOURCES.includes(source)) throw badRequest('资源来源只能是 curseforge 或 modrinth');
  const projectId = text(searchParams.get('project_id'), { field: '项目 ID', min: 1, max: 100 });
  const lang = String(searchParams.get('lang') || 'zh-CN');
  return { source, projectId, lang };
}

/** 一条翻译的对外结构（与启动器 ContentTranslationService 的字段一一对应） */
function translationJson(row) {
  return {
    id: row.id,
    source: row.source,
    project_id: row.project_id,
    project_name: row.project_name,
    lang: row.lang,
    summary: row.summary,
    detail_html: row.detail_html,
    author_name: row.display_name || row.username || '',
    status: row.status,
    review_note: row.review_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export default function register(router) {
  /**
   * 公开：某资源当前对外展示的翻译（最近一条审核通过的）。
   * 启动器详情页加载后调一次；没有翻译时 translation 为 null，接口照样 200。
   */
  router.get('/api/content-translations', async (ctx) => {
    const { source, projectId, lang } = lookupParams(ctx.url.searchParams);
    const row = db
      .prepare(
        `SELECT t.*, u.username, u.display_name
           FROM content_translations t
           LEFT JOIN users u ON u.id = t.user_id
          WHERE t.source = ? AND t.project_id = ? AND t.lang = ? AND t.status = 'approved'
          ORDER BY t.reviewed_at DESC, t.id DESC
          LIMIT 1`,
      )
      .get(source, projectId, lang);
    return { translation: row ? translationJson(row) : null };
  });

  /**
   * 自己对某资源的最新一条提交（含待审核 / 已驳回），「完善翻译」预填与状态展示用。
   * 只要自己交过就返回，哪怕是待审核的——作者看到的是自己上次交的内容。
   */
  router.get('/api/content-translations/mine', async (ctx) => {
    const user = requireUser(ctx.user);
    const { source, projectId, lang } = lookupParams(ctx.url.searchParams);
    const row = db
      .prepare(
        `SELECT t.*, u.username, u.display_name
           FROM content_translations t
           LEFT JOIN users u ON u.id = t.user_id
          WHERE t.source = ? AND t.project_id = ? AND t.lang = ? AND t.user_id = ?
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT 1`,
      )
      .get(source, projectId, lang, user.id);
    return { translation: row ? translationJson(row) : null };
  });

  /**
   * 提交翻译：登录用户每小时最多 10 条，全部进入待审核。
   * 简介必填，详细信息可选（没动过详情区就不传，公开展示时两项各自独立覆盖）。
   */
  router.post('/api/content-translations', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`content-translation:${user.id}`, 10, 60 * 60 * 1000, '翻译提交太频繁，请稍后再试');

    const body = await ctx.json();
    const source = String(body.source || '');
    if (!SOURCES.includes(source)) throw badRequest('资源来源只能是 curseforge 或 modrinth');
    const projectId = text(body.project_id, { field: '项目 ID', min: 1, max: 100 });
    const lang = String(body.lang || 'zh-CN');
    if (!LANGS.includes(lang)) throw badRequest('暂不支持这个目标语言');

    const summary = text(body.summary, { field: '简介翻译', min: 2, max: 500 });
    const detailHtml = text(body.detail_html, { field: '详细信息翻译', max: 200000, optional: true }) || '';
    if (!summary && !detailHtml) throw badRequest('至少要翻译简介或详细信息其中一项');
    guardBannedWords(user, `${summary}\n${stripHtmlTags(detailHtml)}`, { action: '翻译' });

    const projectName = text(body.project_name, { field: '资源名称', max: 150, optional: true }) || '';
    const sourceSummary = text(body.source_summary, { field: '原文简介', max: 2000, optional: true }) || '';
    const sourceDetailHtml =
      text(body.source_detail_html, { field: '原文详细信息', max: 200000, optional: true }) || '';

    const timestamp = now();
    const info = db
      .prepare(
        `INSERT INTO content_translations
           (user_id, source, project_id, project_name, lang,
            summary, detail_html, source_summary, source_detail_html,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        user.id,
        source,
        projectId,
        projectName,
        lang,
        summary,
        detailHtml,
        sourceSummary,
        sourceDetailHtml,
        timestamp,
        timestamp,
      );
    return { ok: true, id: Number(info.lastInsertRowid), status: 'pending' };
  });

  // ---------------- 管理：翻译审核 ----------------

  /** 审核队列：按状态筛选（默认看待审核），带提交人信息与计数 */
  router.get('/api/admin/content-translations', async (ctx) => {
    requireAdmin(ctx.user);
    const statusParam = ctx.url.searchParams.get('status') || 'pending';
    const status = ['pending', 'approved', 'rejected', 'all'].includes(statusParam) ? statusParam : 'pending';
    const page = Math.max(1, Math.floor(Number(ctx.url.searchParams.get('page') || 1)) || 1);
    const perPage = Math.min(60, Math.max(1, Math.floor(Number(ctx.url.searchParams.get('per_page') || 20)) || 20));
    const where = status === 'all' ? '' : 'WHERE t.status = ?';
    const params = status === 'all' ? [] : [status];

    const total = db.prepare(`SELECT COUNT(*) AS n FROM content_translations t ${where}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT t.*, u.username, u.display_name,
                r.username AS reviewed_by_name
           FROM content_translations t
           LEFT JOIN users u ON u.id = t.user_id
           LEFT JOIN users r ON r.id = t.reviewed_by
           ${where}
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, perPage, (page - 1) * perPage);

    return {
      status,
      translations: rows.map((row) => ({
        ...translationJson(row),
        user: row.user_id
          ? { id: row.user_id, username: row.username, display_name: row.display_name || row.username }
          : null,
        reviewed_by: row.reviewed_by_name || '',
        source_summary: row.source_summary,
        source_detail_html: row.source_detail_html,
      })),
      counts: {
        pending: db.prepare("SELECT COUNT(*) AS n FROM content_translations WHERE status = 'pending'").get().n,
        approved: db.prepare("SELECT COUNT(*) AS n FROM content_translations WHERE status = 'approved'").get().n,
        rejected: db.prepare("SELECT COUNT(*) AS n FROM content_translations WHERE status = 'rejected'").get().n,
      },
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  /** 审核：通过 / 驳回（可带理由），处理结果以系统通知推给提交人 */
  router.patch('/api/admin/content-translations/:id', async (ctx) => {
    const admin = requireAdmin(ctx.user);
    const row = db.prepare('SELECT * FROM content_translations WHERE id = ?').get(Number(ctx.params.id));
    if (!row) throw notFound('翻译提交不存在');

    const body = await ctx.json();
    const status = String(body.status || '');
    if (!REVIEW_STATUSES.includes(status)) throw badRequest('状态只能是 approved 或 rejected');
    const reviewNote = text(body.review_note, { field: '审核备注', max: 300, optional: true }) || '';

    db.prepare(
      'UPDATE content_translations SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
    ).run(status, reviewNote, admin.id, now(), row.id);

    if (row.user_id) {
      const label = row.project_name || `${row.source} ${row.project_id}`;
      if (status === 'approved') {
        notifyAdminMessage(
          row.user_id,
          '您的翻译已通过审核',
          `您为「${label}」提交的翻译已通过审核，其他用户打开详情页就能看到了。感谢参与！`,
        );
      } else {
        notifyAdminMessage(
          row.user_id,
          '您的翻译未通过审核',
          reviewNote || `您为「${label}」提交的翻译未通过审核，修改后可以再次提交。`,
        );
      }
    }
    return { ok: true, status };
  });
}
