import { db, now } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { requireAdmin } from '../lib/auth.js';
import { DM_SELECT, dmOut, peerOut } from '../lib/social.js';
import { isSupportUser, supportUserId } from '../lib/support.js';
import { int, text } from '../lib/validate.js';

/**
 * 管理后台 · 官方客服工作台。
 *
 * 玩家在聊天页里给「方块盒子官方客服」发私信；管理员登录后台后，
 * 以客服账号的身份查看这些会话并回复（回复直接写进私信表，
 * 客户端下一次轮询 / 打开会话就能看到）。
 */

/** 会话列表：只列和客服有过消息往来的玩家，按最后一条消息时间倒序 */
function listConversations(supportId, limit = 100) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar, u.status, u.last_seen_at,
              d.id AS last_id, d.body, d.kind, d.created_at, d.sender_id,
              (SELECT COUNT(*) FROM direct_messages x
                WHERE x.sender_id = u.id AND x.peer_id = ? AND x.read_at = 0) AS unread
         FROM users u
         JOIN direct_messages d ON d.id = (
           SELECT MAX(m.id) FROM direct_messages m
            WHERE (m.sender_id = ? AND m.peer_id = u.id)
               OR (m.sender_id = u.id AND m.peer_id = ?)
         )
        ORDER BY d.id DESC
        LIMIT ?`,
    )
    .all(supportId, supportId, supportId, limit)
    .map((row) => ({
      user: {
        ...peerOut(row),
        status: row.status || 'active',
      },
      unread: row.unread || 0,
      last_message: {
        id: row.last_id,
        body: row.body,
        kind: row.kind || 'text',
        created_at: row.created_at,
        mine: row.sender_id === supportId,
      },
    }));
}

/** 客服 id 与账号卡片 */
function supportInfo() {
  const supportId = supportUserId();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(supportId);
  return { supportId, support: peerOut(row) };
}

export default function register(router) {
  /** 工作台首页：客服账号信息 + 所有会话 + 总未读 */
  router.get('/api/admin/support/overview', async (ctx) => {
    requireAdmin(ctx.user);
    const { supportId, support } = supportInfo();
    const conversations = listConversations(supportId);
    return {
      support,
      conversations,
      unread_total: conversations.reduce((sum, item) => sum + item.unread, 0),
    };
  });

  /** 打开某个玩家的会话：顺手把玩家发来的消息标记为已读 */
  router.get('/api/admin/support/conversations/:userId', async (ctx) => {
    requireAdmin(ctx.user);
    const { supportId } = supportInfo();
    const userId = int(ctx.params.userId, { field: '玩家' });
    if (isSupportUser(userId)) throw badRequest('这是官方客服自己');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!target) throw notFound('用户不存在');

    db.prepare(
      'UPDATE direct_messages SET read_at = ? WHERE sender_id = ? AND peer_id = ? AND read_at = 0',
    ).run(now(), userId, supportId);

    const beforeId = int(ctx.url.searchParams.get('before_id'), { field: 'before_id', fallback: 0 });
    const limit = Math.min(100, Math.max(1, int(ctx.url.searchParams.get('limit'), { field: 'limit', fallback: 60 })));
    const params = [supportId, userId, userId, supportId];
    let where = '';
    if (beforeId > 0) {
      where = 'AND m.id < ?';
      params.push(beforeId);
    }
    const rows = db
      .prepare(
        `${DM_SELECT}
          WHERE ((m.sender_id = ? AND m.peer_id = ?) OR (m.sender_id = ? AND m.peer_id = ?)) ${where}
          ORDER BY m.id DESC
          LIMIT ?`,
      )
      .all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map((row) => dmOut(row, supportId));
    return {
      user: {
        ...peerOut(target),
        bio: target.bio || '',
        created_at: target.created_at || 0,
        status: target.status || 'active',
      },
      messages,
      has_more: hasMore,
    };
  });

  /** 以官方客服的身份回复玩家：写进私信表，客户端轮询即可收到 */
  router.post('/api/admin/support/conversations/:userId', async (ctx) => {
    requireAdmin(ctx.user);
    const { supportId } = supportInfo();
    const userId = int(ctx.params.userId, { field: '玩家' });
    if (isSupportUser(userId)) throw badRequest('这是官方客服自己');
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!target) throw notFound('用户不存在');

    const body = await ctx.json();
    const content = text(body.body, { field: '回复内容', min: 1, max: 1000 });

    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO direct_messages (sender_id, peer_id, body, kind, created_at)
         VALUES (?, ?, ?, 'text', ?)`,
      )
      .run(supportId, userId, content, timestamp);
    // 客服刚刚在线过：玩家端看到的「最近活跃」不会一直停在创建时间
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(timestamp, supportId);

    const row = db.prepare(`${DM_SELECT} WHERE m.id = ?`).get(Number(result.lastInsertRowid));
    return { message: dmOut(row, supportId) };
  });
}
