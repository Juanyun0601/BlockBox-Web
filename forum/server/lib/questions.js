/**
 * 有奖问答（悬赏方块）
 *
 * 和帖子 / 资源 / 教程并列的第四个大类。规则很简单，但每一环都要保证「赏金真的发得出去」：
 *   1. 发起：作者从自己的方块余额里扣下赏金，交给服务端托管（不是口头承诺）；
 *   2. 采纳：发布之后，作者可以挑任意一层回答采纳，赏金当场打进那一层的作者账户；
 *   3. 兜底：30 天内作者一直没采纳，服务端自动把赏金发给「点赞最多」的回答楼层
 *      （点赞一样多时给楼层更靠前的），保证不会出现「有人回答了却永远拿不到」；
 *   4. 无人回答：到期一层有效回答都没有，赏金原路退回作者；
 *   5. 作者删帖：帖子被作者或管理员删除时，还没结算的赏金立刻退回作者，不和帖子一起消失。
 *
 * 所有改动都在事务里做，并且用 status = 'open' 做发放前的最后一道闸，
 * 避免「作者点采纳」和「到期自动结算」同时发生导致重复发钱。
 */
import { db, now, transaction } from '../db.js';
import { badRequest, notFound } from './http.js';
import { isAdminRole } from './auth.js';
import { createNotification } from './notify.js';

/** 有奖问答固定发到这个板块（老库在 db.js 的 migrate 里补建） */
export const QUESTION_BOARD_SLUG = 'qa';
/** 单条问答的赏金范围（方块） */
export const BOUNTY_MIN = 1;
export const BOUNTY_MAX = 500;
/** 作者多久不采纳就自动按点赞数结算（天） */
export const QUESTION_DAYS = 30;

const DAY_SECONDS = 24 * 60 * 60;

/** 赏金必须是 1~500 的整数，不合法直接拒绝 */
export function normalizeBounty(value) {
  const bounty = Math.floor(Number(value));
  if (!Number.isInteger(bounty) || bounty < BOUNTY_MIN || bounty > BOUNTY_MAX) {
    throw badRequest(`悬赏金额要填 ${BOUNTY_MIN}~${BOUNTY_MAX} 个方块`, 'bad_bounty');
  }
  return bounty;
}

/** 一条问答的托管记录（没有就是普通帖子） */
export function questionRow(threadId) {
  return db.prepare('SELECT * FROM thread_questions WHERE thread_id = ?').get(threadId) || null;
}

/**
 * 发起时扣走作者账户里的方块，放进托管（调用方必须已经在事务里）。
 * 放在事务里是为了「扣钱」和「建帖」同生共死：帖子没建成，钱也不会少。
 */
export function lockBounty({ threadId, authorId, bounty, timestamp = now() }) {
  const amount = normalizeBounty(bounty);
  const account = db.prepare('SELECT points FROM users WHERE id = ?').get(authorId);
  if (!account) throw notFound('用户不存在');
  const balance = Number(account.points) || 0;
  if (balance < amount) {
    throw badRequest(
      `方块不够：悬赏要 ${amount} 方块，你现在只有 ${balance} 方块（每天签到可以攒）`,
      'not_enough_points',
    );
  }

  db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(amount, authorId);
  db.prepare(
    `INSERT INTO point_transactions (user_id, amount, kind, note, created_at)
     VALUES (?, ?, 'bounty_lock', ?, ?)`,
  ).run(authorId, -amount, `发起有奖问答，托管 ${amount} 方块`, timestamp);
  db.prepare(
    `INSERT INTO thread_questions (thread_id, bounty, status, deadline, created_at)
     VALUES (?, ?, 'open', ?, ?)`,
  ).run(threadId, amount, timestamp + QUESTION_DAYS * DAY_SECONDS, timestamp);
  return amount;
}

/** 一层有效回答：顶层楼层（不含楼中楼）、不是楼主的、没被删、作者还在 */
function answerPost(threadId, postId) {
  return db
    .prepare(
      `SELECT p.id, p.thread_id, p.author_id, p.floor, p.deleted
         FROM posts p
         JOIN threads t ON t.id = p.thread_id
         JOIN users u ON u.id = p.author_id
        WHERE p.id = ? AND p.thread_id = ? AND p.parent_post_id IS NULL
        LIMIT 1`,
    )
    .get(postId, threadId) || null;
}

/** 到期自动结算时挑的那一层：只看顶层楼层，点赞最多，同赞数取楼层靠前的 */
function bestAnswer(threadId, authorId) {
  return db
    .prepare(
      `SELECT p.id, p.author_id, p.floor
         FROM posts p
         JOIN users u ON u.id = p.author_id
        WHERE p.thread_id = ? AND p.parent_post_id IS NULL
          AND p.floor > 1 AND p.deleted = 0 AND p.author_id <> ?
        ORDER BY (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) DESC, p.floor ASC
        LIMIT 1`,
    )
    .get(threadId, authorId) || null;
}

/**
 * 把赏金发给某一层：置结算状态、给中奖人加方块、记流水、发通知。
 * 已经是终态（别人先结算了）就返回 false，不再重复发钱。
 */
function payAnswer({ thread, question, post, source, operatorId = null, timestamp = now() }) {
  return transaction(() => {
    const changed = db
      .prepare(
        `UPDATE thread_questions
            SET status = 'settled', winner_post_id = ?, winner_user_id = ?,
                settle_source = ?, settled_at = ?
          WHERE thread_id = ? AND status = 'open'`,
      )
      .run(post.id, post.author_id, source, timestamp, thread.id).changes;
    if (!changed) return false;

    const bounty = Number(question.bounty) || 0;
    db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(bounty, post.author_id);
    db.prepare(
      `INSERT INTO point_transactions (user_id, amount, kind, note, created_at)
       VALUES (?, ?, 'bounty_award', ?, ?)`,
    ).run(post.author_id, bounty, `有奖问答赏金（${thread.title} · ${post.floor} 楼）`.slice(0, 200), timestamp);

    // 通知中奖人；自动结算时顺便告诉作者赏金发给了谁
    createNotification({
      userId: post.author_id,
      type: 'system',
      targetKind: 'thread',
      actorId: operatorId || thread.author_id,
      threadId: thread.id,
      postId: post.id,
      threadTitle: thread.title,
      content: `你在「${thread.title}」的回答被采纳，赏金 ${bounty} 方块已到账`,
    });
    if (source === 'likes' && thread.author_id !== post.author_id) {
      createNotification({
        userId: thread.author_id,
        type: 'system',
        targetKind: 'thread',
        actorId: null,
        threadId: thread.id,
        postId: post.id,
        threadTitle: thread.title,
        content: `「${thread.title}」30 天没有采纳，赏金已按规则发给点赞最多的 ${post.floor} 楼`,
      });
    }
    return true;
  });
}

/** 作者（或管理员）采纳某一层回答 */
export function acceptAnswer({ threadId, postId, actor }) {
  const thread = db
    .prepare('SELECT id, author_id, title, deleted FROM threads WHERE id = ?')
    .get(threadId);
  if (!thread || thread.deleted) throw notFound('主题不存在或已被删除');

  const question = questionRow(threadId);
  if (!question) throw badRequest('这条帖子不是有奖问答', 'not_question');
  if (question.status !== 'open') throw badRequest('这条问答已经结算过了', 'question_settled');

  const admin = isAdminRole(actor.role);
  if (thread.author_id !== actor.id && !admin) {
    throw badRequest('只有提问者本人能采纳答案', 'not_question_author');
  }

  const post = answerPost(threadId, postId);
  if (!post || post.deleted) throw badRequest('要采纳的楼层不存在或已被删除', 'bad_accept_target');
  if (post.floor <= 1 || post.author_id === thread.author_id) {
    throw badRequest('只能采纳别人的回答楼层', 'cannot_accept_own');
  }

  const done = payAnswer({
    thread,
    question,
    post,
    source: admin && thread.author_id !== actor.id ? 'admin' : 'author',
    operatorId: actor.id,
  });
  if (!done) throw badRequest('这条问答已经结算过了', 'question_settled');
  return questionRow(threadId);
}

/** 把还没结算的赏金退回作者（删帖 / 无人回答时用） */
export function refundQuestion(threadId, source = 'refund') {
  const question = questionRow(threadId);
  if (!question || question.status !== 'open') return null;

  const thread = db.prepare('SELECT id, author_id, title, deleted FROM threads WHERE id = ?').get(threadId);
  if (!thread) return null;

  const done = transaction(() => {
    const changed = db
      .prepare(
        `UPDATE thread_questions
            SET status = 'refunded', settle_source = ?, settled_at = ?
          WHERE thread_id = ? AND status = 'open'`,
      )
      .run(source, now(), threadId).changes;
    if (!changed) return false;

    const bounty = Number(question.bounty) || 0;
    db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(bounty, thread.author_id);
    db.prepare(
      `INSERT INTO point_transactions (user_id, amount, kind, note, created_at)
       VALUES (?, ?, 'bounty_refund', ?, ?)`,
    ).run(thread.author_id, bounty, `有奖问答赏金退回（${thread.title}）`.slice(0, 200), now());
    return true;
  });
  if (!done) return null;

  // 无人回答的退款也告诉作者一声，避免他以为方块凭空少了
  if (source === 'refund') {
    createNotification({
      userId: thread.author_id,
      type: 'system',
      targetKind: 'thread',
      actorId: null,
      threadId: thread.id,
      postId: null,
      threadTitle: thread.title,
      content: `「${thread.title}」30 天内没人回答，悬赏的 ${question.bounty} 方块已退回你的账户`,
    });
  }
  return questionRow(threadId);
}

/** 到期的问答按点赞数自动结算（单条；被删帖的走退款） */
export function settleQuestionIfDue(threadId) {
  const question = questionRow(threadId);
  if (!question || question.status !== 'open') return null;
  if (Number(question.deadline) > now()) return null;

  const thread = db.prepare('SELECT id, author_id, title, deleted FROM threads WHERE id = ?').get(threadId);
  if (!thread) return null;
  if (thread.deleted) return refundQuestion(threadId, 'thread_deleted');

  const post = bestAnswer(threadId, thread.author_id);
  if (!post) return refundQuestion(threadId, 'refund');

  const done = payAnswer({ thread, question, post, source: 'likes' });
  return done ? questionRow(threadId) : null;
}

/**
 * 定时任务 / 启动时跑一遍：所有过了 30 天还没结算的问答统一结算。
 * @returns 本次处理了多少条
 */
export function settleDueQuestions({ limit = 200 } = {}) {
  const rows = db
    .prepare(
      `SELECT thread_id FROM thread_questions
        WHERE status = 'open' AND deadline <= ?
        ORDER BY deadline ASC
        LIMIT ?`,
    )
    .all(now(), Math.max(1, Math.min(1000, Number(limit) || 200)));

  let handled = 0;
  for (const row of rows) {
    try {
      if (settleQuestionIfDue(Number(row.thread_id))) handled += 1;
    } catch (error) {
      console.error(`[论坛] 有奖问答自动结算失败（#${row.thread_id}）：`, error.message);
    }
  }
  return handled;
}

/** 对外 JSON：列表里带赏金与状态，详情里再补中奖人 / 能否采纳 */
export function questionOut(row) {
  return {
    bounty: Number(row.bounty) || 0,
    status: row.status || 'open',
    deadline: row.deadline || 0,
    winner_post_id: row.winner_post_id || null,
    winner_user_id: row.winner_user_id || null,
    settle_source: row.settle_source || '',
    settled_at: row.settled_at || 0,
  };
}
