/**
 * 资源详情页评论（插件帖 / 投影帖）。
 *
 * 和论坛楼层是两套东西：
 * - 楼层是「主题」，有楼层号、有楼中楼、参与主题回复计数；
 * - 评论是「看过资源之后随口说两句」，平铺、没有楼中楼、按最热 + 最新综合排序。
 *
 * 所以这里独立一套表（thread_comments / comment_likes / comment_reports），
 * 不和 posts 混用，避免资源页的评论把主题的楼层号与回复数搅乱。
 *
 * 语气与人话都沿用论坛的规矩：要先登录、要先过入站答题、要过违禁词、
 * 有空闲与频率限制；作者和管理员可以删评论，其他人只能点赞或举报。
 */
import { db, paginate, now } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { assertCanPost, isAdminRole, requireUser } from '../lib/auth.js';
import { enforce } from '../lib/rate-limit.js';
import { text } from '../lib/validate.js';
import { commentOut } from '../lib/serialize.js';
import { getThread, listComments, countComments, likedCommentIds, getComment } from '../lib/queries.js';
import { guardBannedWords } from '../lib/banned-words.js';
import { notifyThreadComment } from '../lib/notify.js';

/** 举报分类白名单：与楼层举报保持一致 */
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

/** 取主题并做存在性 / 锁定校验，评论区 checklist 复用 */
function requireThread(threadId, { user = null, allowLocked = false } = {}) {
  if (!Number.isInteger(threadId) || threadId <= 0) throw notFound('主题不存在');
  const thread = getThread(threadId);
  if (!thread || thread.deleted) throw notFound('主题不存在或已被删除');
  if (!allowLocked && thread.locked && !(user && isAdminRole(user.role))) {
    throw badRequest('这个主题已被锁定，暂时不能评论', 'thread_locked');
  }
  return thread;
}

export default function register(router) {
  // ---------------- 评论列表 ----------------

  router.get('/api/threads/:id/comments', async (ctx) => {
    const threadId = Number(ctx.params.id);
    requireThread(threadId, { allowLocked: true });

    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);
    const rows = listComments(threadId, { limit: perPage, offset });
    const total = countComments(threadId);
    const liked = likedCommentIds(ctx.user?.id, rows.map((row) => row.id));

    return {
      comments: rows.map((row) => commentOut({ ...row, liked: liked.has(row.id) })),
      total,
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  // ---------------- 发表评论 ----------------

  router.post('/api/threads/:id/comments', async (ctx) => {
    const user = assertCanPost(ctx.user, 'reply');
    enforce(`comment:${user.id}`, 20, 5 * 60 * 1000, '评论太频繁');
    enforce(`comment-ip:${ctx.ip}`, 30, 5 * 60 * 1000, '评论太频繁');

    const thread = requireThread(Number(ctx.params.id), { user });
    const body = await ctx.json();
    const content = text(body.content, { field: '评论内容', min: 1, max: 2000 });
    guardBannedWords(user, content, { action: '评论' });

    const timestamp = now();
    const inserted = db
      .prepare(
        `INSERT INTO thread_comments (thread_id, author_id, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(thread.id, user.id, content, timestamp, timestamp);
    const commentId = Number(inserted.lastInsertRowid);

    // 新评论把主题的「最后活动」往前推，资源帖才会在列表里浮上来；
    // reply_count 只记楼层，评论数单独算，两者不混。
    db.prepare('UPDATE threads SET last_post_at = ?, last_post_user_id = ? WHERE id = ?').run(
      timestamp,
      user.id,
      thread.id,
    );

    // 通知楼主与 @ 到的人；通知失败不影响已经发出去的评论
    try {
      notifyThreadComment({ thread, comment: { id: commentId, content }, actor: user });
    } catch (error) {
      console.error('[论坛] 评论通知生成失败（不影响评论）：', error.message);
    }

    const row = getComment(commentId);
    return { comment: commentOut({ ...row, liked: false }), thread_id: thread.id, total: countComments(thread.id) };
  });

  // ---------------- 点赞 ----------------

  router.post('/api/comments/:id/like', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`comment-like:${user.id}`, 200, 10 * 60 * 1000, '点赞太频繁');

    const comment = db
      .prepare('SELECT id, thread_id, deleted FROM thread_comments WHERE id = ?')
      .get(Number(ctx.params.id));
    if (!comment || comment.deleted) throw notFound('评论不存在');

    const existing = db
      .prepare('SELECT 1 AS hit FROM comment_likes WHERE user_id = ? AND comment_id = ?')
      .get(user.id, comment.id);
    const body = await ctx.json().catch(() => ({}));
    const want = body.like === undefined ? !existing : !!body.like;

    if (want && !existing) {
      db.prepare('INSERT INTO comment_likes (user_id, comment_id, created_at) VALUES (?, ?, ?)').run(
        user.id,
        comment.id,
        now(),
      );
    } else if (!want && existing) {
      db.prepare('DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?').run(user.id, comment.id);
    }

    const likes = db.prepare('SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = ?').get(comment.id).n;
    return { liked: want, likes };
  });

  // ---------------- 删除 ----------------

  router.delete('/api/comments/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const comment = db.prepare('SELECT * FROM thread_comments WHERE id = ?').get(Number(ctx.params.id));
    if (!comment || comment.deleted) throw notFound('评论不存在');
    if (comment.author_id !== user.id && !isAdminRole(user.role)) throw badRequest('只能删除自己的评论');

    // 软删除：点赞记录留着，评论数按 deleted = 0 统计，页面上直接消失
    db.prepare('UPDATE thread_comments SET deleted = 1, updated_at = ? WHERE id = ?').run(now(), comment.id);
    db.prepare("UPDATE comment_reports SET status = 'ignored' WHERE comment_id = ? AND status = 'open'").run(
      comment.id,
    );
    return { ok: true, total: countComments(comment.thread_id) };
  });

  // ---------------- 举报 ----------------

  router.post('/api/comments/:id/report', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`report:${user.id}`, 10, 60 * 60 * 1000, '举报太频繁');

    const comment = db
      .prepare('SELECT id, thread_id, author_id, deleted FROM thread_comments WHERE id = ?')
      .get(Number(ctx.params.id));
    if (!comment || comment.deleted) throw notFound('评论不存在');
    if (comment.author_id === user.id) throw badRequest('不用举报自己');

    const body = await ctx.json();
    const category = REPORT_CATEGORIES.includes(String(body.category || '')) ? String(body.category) : '';
    const reason = text(body.reason, { field: '举报理由', max: 200, optional: true });

    const existing = db
      .prepare('SELECT id, status FROM comment_reports WHERE comment_id = ? AND reporter_id = ?')
      .get(comment.id, user.id);
    if (existing) {
      if (existing.status === 'open') return { ok: true, duplicated: true };
      db.prepare(
        'UPDATE comment_reports SET status = ?, category = ?, reason = ?, created_at = ? WHERE id = ?',
      ).run('open', category, reason, now(), existing.id);
      return { ok: true, duplicated: true };
    }

    db.prepare(
      `INSERT INTO comment_reports (comment_id, thread_id, reporter_id, category, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(comment.id, comment.thread_id, user.id, category, reason, now());
    return { ok: true };
  });
}
