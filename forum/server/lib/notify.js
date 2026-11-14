import { db, now } from '../db.js';
import { snippetOf } from './serialize.js';

/** @用户名（中文、字母、数字、下划线、短横线），和前端高亮规则保持一致 */
const MENTION_RE = /@([A-Za-z0-9_\u4e00-\u9fa5-]{2,20})/g;

export function parseMentions(content) {
  if (!content) return [];
  const found = new Set();
  for (const match of String(content).matchAll(MENTION_RE)) found.add(match[1]);
  return [...found];
}

export function unreadNotifications(userId) {
  if (!userId) return 0;
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at = 0').get(userId).n;
}

function alreadyNotified(userId, postId, type) {
  if (!postId) return false;
  return !!db
    .prepare('SELECT 1 AS hit FROM notifications WHERE user_id = ? AND post_id = ? AND type = ?')
    .get(userId, postId, type);
}

export function createNotification({
  userId,
  type = 'reply',
  targetKind = 'thread',
  actorId = null,
  threadId = null,
  postId = null,
  threadTitle = '',
  content = '',
  excerptMax = 90,
}) {
  if (!userId) return false;
  if (alreadyNotified(userId, postId, type)) return false;
  db.prepare(
    `INSERT INTO notifications (user_id, type, target_kind, actor_id, thread_id, post_id, thread_title, excerpt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    type,
    targetKind,
    actorId,
    threadId,
    postId,
    String(threadTitle || '').slice(0, 120),
    snippetOf(content, excerptMax),
    now(),
  );
  return true;
}

/**
 * 管理员给用户发系统通知（target_kind = admin）：后台回复用户、
 * 举报 / 反馈处理结果都走这里。不带 actor，两端显示为「系统 / 管理团队」。
 */
export function notifyAdminMessage(userId, title, content) {
  return createNotification({
    userId,
    type: 'system',
    targetKind: 'admin',
    threadTitle: title,
    content,
    excerptMax: 200,
  });
}

/**
 * 发帖 / 回复后统一处理：
 * - 通知楼主（type reply / thread）
 * - 楼中楼里回复了某人的楼层，也通知那个人（type reply / post）
 * - 通知被 @ 的人（type mention）
 */
export function notifyThreadActivity({ thread, post, actor, parentPostAuthorId = null }) {
  const targets = new Map();

  if (thread.author_id !== actor.id) targets.set(thread.author_id, { type: 'reply', kind: 'thread' });

  if (parentPostAuthorId && parentPostAuthorId !== actor.id && !targets.has(parentPostAuthorId)) {
    targets.set(parentPostAuthorId, { type: 'reply', kind: 'post' });
  }

  for (const name of parseMentions(post.content)) {
    const user = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(name);
    if (!user || user.id === actor.id) continue;
    if (!targets.has(user.id)) targets.set(user.id, { type: 'mention', kind: 'post' });
  }

  let created = 0;
  for (const [userId, meta] of targets) {
    const ok = createNotification({
      userId,
      type: meta.type,
      targetKind: meta.kind,
      actorId: actor.id,
      threadId: thread.id,
      postId: post.id,
      threadTitle: thread.title,
      content: post.content,
    });
    if (ok) created += 1;
  }
  return created;
}

/**
 * 资源帖收到评论后：通知楼主 + 评论里 @ 到的人。
 *
 * 评论没有楼层（post_id 为空），所以 target_kind 一律按主题算，
 * 客户端点开通知直接进主题页就行。
 */
export function notifyThreadComment({ thread, comment, actor }) {
  const targets = new Map();

  if (thread.author_id !== actor.id) targets.set(thread.author_id, 'reply');

  for (const name of parseMentions(comment.content)) {
    const user = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(name);
    if (!user || user.id === actor.id) continue;
    if (!targets.has(user.id)) targets.set(user.id, 'mention');
  }

  let created = 0;
  for (const [userId, type] of targets) {
    const ok = createNotification({
      userId,
      type,
      targetKind: 'thread',
      actorId: actor.id,
      threadId: thread.id,
      postId: null,
      threadTitle: thread.title,
      content: comment.content,
    });
    if (ok) created += 1;
  }
  return created;
}

export function markAllRead(userId) {  return db
    .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at = 0')
    .run(now(), userId).changes;
}

export function markRead(userId, ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const statement = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at = 0');
  let changed = 0;
  for (const id of ids.slice(0, 200)) {
    changed += Number(statement.run(now(), Number(id), userId).changes || 0);
  }
  return changed;
}
