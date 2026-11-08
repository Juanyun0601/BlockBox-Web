import { db, now } from '../db.js';
import { supportUserId } from './support.js';

/** 最近活跃多久以内算「在线」（userFromToken 每 5 分钟会刷一次 last_seen_at） */
export const ONLINE_WINDOW = 10 * 60;

/** 好友列表一次最多返回多少人（按最近联系排序） */
export const MAX_FRIENDS = 200;

/** 用户卡片：只暴露好友 / 私信需要的字段；official 标记官方客服账号 */
export function peerOut(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name || row.username,
    avatar: row.avatar || '',
    last_seen_at: row.last_seen_at || 0,
    online: now() - (row.last_seen_at || 0) <= ONLINE_WINDOW,
    official: row.id === supportUserId(),
  };
}

/**
 * 私信统一序列化：kind = text / image / file / withdrawn（撤回占位），带引用摘要。
 * viewerId 决定 mine / reply_mine，用户页与后台客服工作台共用。
 * 私信永不走 CDN：image / file_url 一律站内相对路径，客户端拼论坛自己的地址。
 */
export function dmOut(row, viewerId) {
  let replyBody = '';
  if (row.reply_to) {
    const replyKind = row.reply_kind || 'text';
    if (replyKind === 'withdrawn') replyBody = '[已撤回]';
    else if (replyKind === 'image') replyBody = '[图片]';
    else if (replyKind === 'file') replyBody = '[文件]';
    else replyBody = String(row.reply_body || '').slice(0, 60);
  }
  return {
    id: row.id,
    kind: row.kind || 'text',
    body: row.body,
    image: row.image || '',
    file_url: row.file_url || '',
    file_name: row.file_name || '',
    file_size: row.file_size || 0,
    reply_to: row.reply_to || 0,
    reply_body: replyBody,
    reply_mine: row.reply_sender === viewerId ? 1 : 0,
    mine: row.sender_id === viewerId,
    created_at: row.created_at,
    read_at: row.read_at || 0,
  };
}

/** 带引用消息的 SELECT 片段（配合 dmOut 使用） */
export const DM_SELECT = `
  SELECT m.id, m.sender_id, m.body, m.kind, m.image, m.file_url, m.file_name, m.file_size, m.reply_to, m.read_at, m.created_at,
         q.body AS reply_body, q.kind AS reply_kind, q.sender_id AS reply_sender
    FROM direct_messages m
    LEFT JOIN direct_messages q ON q.id = m.reply_to`;

/** 两人之间的关系行（任意状态），没有则返回 undefined */
export function friendshipBetween(a, b) {
  return db
    .prepare(
      `SELECT * FROM friendships
        WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
    )
    .get(a, b, b, a);
}

/** 两人是否已是好友 */
export function acceptedBetween(a, b) {
  const row = friendshipBetween(a, b);
  return row && row.status === 'accepted' ? row : null;
}

/**
 * 好友列表：带未读私信数与最后一条私信，按最近联系排序。
 * 三条聚合查询替代逐个好友查两次，避免 N+1。
 */
export function listFriends(meId) {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar, u.last_seen_at,
              f.updated_at AS friend_since
         FROM friendships f
         JOIN users u
           ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
        WHERE f.status = 'accepted'
          AND (f.requester_id = ? OR f.addressee_id = ?)
          AND u.status != 'banned'
        ORDER BY (u.id = ?) DESC, f.updated_at DESC
        LIMIT ?`,
    )
    .all(meId, meId, meId, supportUserId(), MAX_FRIENDS);
  if (rows.length === 0) return [];

  /** 每个好友的最后一条私信（会话两侧都算） */
  const lastMap = new Map();
  const lastRows = db
    .prepare(
      `SELECT d.body, d.kind, d.created_at,
              CASE WHEN d.sender_id = ? THEN 1 ELSE 0 END AS mine,
              CASE WHEN d.sender_id = ? THEN d.peer_id ELSE d.sender_id END AS friend_id
         FROM direct_messages d
         JOIN ( SELECT MAX(id) AS last_id
                  FROM direct_messages
                 WHERE peer_id = ? OR sender_id = ?
                 GROUP BY CASE WHEN sender_id = ? THEN peer_id ELSE sender_id END ) t
           ON t.last_id = d.id`,
    )
    .all(meId, meId, meId, meId, meId);
  for (const row of lastRows) {
    lastMap.set(row.friend_id, { body: row.body, kind: row.kind, created_at: row.created_at, mine: !!row.mine });
  }

  /** 每个好友发来的未读数 */
  const unreadMap = new Map();
  const unreadRows = db
    .prepare(
      `SELECT sender_id, COUNT(*) AS n
         FROM direct_messages
        WHERE peer_id = ? AND read_at = 0
        GROUP BY sender_id`,
    )
    .all(meId);
  for (const row of unreadRows) unreadMap.set(row.sender_id, row.n);

  const friends = rows.map((row) => ({
    ...peerOut(row),
    unread: unreadMap.get(row.id) || 0,
    last_message: lastMap.get(row.id) || null,
  }));
  // 官方客服始终排在最前面，其余按最近联系排序
  friends.sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1;
    return (b.last_message?.created_at || 0) - (a.last_message?.created_at || 0);
  });
  return friends;
}

/** 待处理的好友申请（incoming = 收到的，outgoing = 发出的） */
export function listRequests(meId, direction) {
  const incoming = direction !== 'outgoing';
  const rows = db
    .prepare(
      `SELECT f.id, f.created_at,
              u.id AS uid, u.username, u.display_name, u.avatar, u.last_seen_at
         FROM friendships f
         JOIN users u ON u.id = ${incoming ? 'f.requester_id' : 'f.addressee_id'}
        WHERE ${incoming ? 'f.addressee_id' : 'f.requester_id'} = ?
          AND f.status = 'pending'
          AND u.status != 'banned'
        ORDER BY f.created_at DESC
        LIMIT 100`,
    )
    .all(meId);
  return rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    user: peerOut({ ...row, id: row.uid }),
  }));
}

/** 未读私信总数（只算没被封禁的发件人） */
export function unreadTotal(meId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM direct_messages dm
         JOIN users su ON su.id = dm.sender_id
        WHERE dm.peer_id = ? AND dm.read_at = 0 AND su.status != 'banned'`,
    )
    .get(meId).n;
}

/** 收到的好友申请数 */
export function incomingRequestCount(meId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM friendships WHERE addressee_id = ? AND status = 'pending'")
    .get(meId).n;
}

/** 顶栏角标用的「社交未读」：未读私信 + 待处理好友申请 */
export function socialUnread(meId) {
  if (!meId) return 0;
  return unreadTotal(meId) + incomingRequestCount(meId);
}
