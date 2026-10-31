import { db, paginate } from '../db.js';
import { enforce } from '../lib/rate-limit.js';
import { threadOut } from '../lib/serialize.js';

/** LIKE 通配符转义，避免用户输入 % 时把整站内容都搜出来 */
function likeEscape(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export default function register(router) {
  router.get('/api/search', async (ctx) => {
    // 以 # 开头的查询当作标签搜（首页标签、帖子里的标签都是 #xxx 链接）
    const raw = String(ctx.url.searchParams.get('q') || '')
      .trim()
      .replace(/^#+/, '');
    enforce(`search:${ctx.ip}`, 40, 60 * 1000, '搜索太频繁');
    if (!raw) return { query: '', results: [], pagination: { page: 1, per_page: 20, total: 0, pages: 1 } };

    const query = raw.slice(0, 60);
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);
    const boardSlug = ctx.url.searchParams.get('board') || '';
    const like = `%${likeEscape(query)}%`;

    const where = [
      't.deleted = 0',
      "(s.title LIKE ? ESCAPE '\\' OR s.body LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM thread_tags tt WHERE tt.thread_id = t.id AND tt.tag LIKE ? ESCAPE '\\'))",
    ];
    const params = [like, like, like];
    if (boardSlug) {
      where.push('b.slug = ?');
      params.push(boardSlug);
    }

    const total = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM thread_search s
           JOIN threads t ON t.id = s.thread_id
           JOIN boards b ON b.id = t.board_id
          WHERE ${where.join(' AND ')}`,
      )
      .get(...params).n;

    const rows = db
      .prepare(
        `SELECT t.id, t.title, t.pinned, t.locked, t.views, t.reply_count, t.created_at, t.last_post_at,
                b.id AS board_id, b.slug AS board_slug, b.name AS board_name, b.icon AS board_icon,
                u.id AS author_id, u.username AS author_username,
                u.display_name AS author_display_name, u.avatar AS author_avatar,
                lu.username AS last_username, lu.display_name AS last_display_name,
                s.body AS search_body
           FROM thread_search s
           JOIN threads t ON t.id = s.thread_id
           JOIN boards b ON b.id = t.board_id
           JOIN users u ON u.id = t.author_id
           LEFT JOIN users lu ON lu.id = t.last_post_user_id
          WHERE ${where.join(' AND ')}
          ORDER BY t.last_post_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, perPage, offset);

    return {
      query,
      results: rows.map((row) => {
        const item = threadOut(row, { withSnippet: false });
        const body = String(row.search_body || '');
        const at = body.toLowerCase().indexOf(query.toLowerCase());
        item.snippet = at >= 0 ? excerpt(body, at, query.length) : '';
        return item;
      }),
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });
}

/** 取命中位置前后一小段文字 */
function excerpt(body, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(body.length, index + length + 60);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return prefix + body.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}
