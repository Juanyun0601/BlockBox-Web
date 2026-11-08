import { db, now } from '../db.js';
import { config } from '../config.js';
import { isOfficialGroup } from './official-group.js';

/** 一个群最多多少人（含群主） */
export const MAX_GROUP_MEMBERS = 50;

/** 建群时最多邀请多少位好友（不含自己） */
export const MAX_GROUP_INVITEES = MAX_GROUP_MEMBERS - 1;

/** 用户卡片：群成员列表只暴露昵称 / 头像需要的字段（peerOut 的轻量版，online 用同一窗口） */
export function memberOut(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name || row.username,
    avatar: row.avatar || '',
    online: now() - (row.last_seen_at || 0) <= 10 * 60,
  };
}

/**
 * 群消息统一序列化：kind = text / image / file / withdrawn（撤回占位），带发送者与引用摘要。
 * viewerId 决定 mine / reply_mine，与 dmOut 保持同款字段，客户端解析可以共用一套结构。
 * 群消息额外带 dl_url：群里图片 / 文件的下载地址，配了 CDN 就是 CDN 域名的完整地址，
 * 没配则退回站内相对路径（客户端拼论坛地址），行为和以前完全一样。
 */
export function groupMessageOut(row, viewerId) {
  let replyBody = '';
  if (row.reply_to) {
    const replyKind = row.reply_kind || 'text';
    if (replyKind === 'withdrawn') replyBody = '[已撤回]';
    else if (replyKind === 'image') replyBody = '[图片]';
    else if (replyKind === 'file') replyBody = '[文件]';
    else replyBody = String(row.reply_body || '').slice(0, 60);
  }
  const mediaPath = row.kind === 'file' ? row.file_url || '' : row.image || '';
  let dlUrl = mediaPath;
  if (dlUrl && config.cdnBase) dlUrl = `${config.cdnBase}${dlUrl}`;
  return {
    id: row.id,
    kind: row.kind || 'text',
    body: row.body,
    image: row.image || '',
    file_url: row.file_url || '',
    file_name: row.file_name || '',
    file_size: row.file_size || 0,
    dl_url: dlUrl,
    reply_to: row.reply_to || 0,
    reply_body: replyBody,
    reply_mine: row.reply_sender === viewerId ? 1 : 0,
    mine: row.sender_id === viewerId,
    created_at: row.created_at,
    sender: {
      id: row.sender_id,
      username: row.sender_username,
      display_name: row.sender_display_name || row.sender_username,
      avatar: row.sender_avatar || '',
    },
  };
}

/** 带发送者与引用消息的 SELECT 片段（配合 groupMessageOut 使用） */
export const GM_SELECT = `
  SELECT m.id, m.group_id, m.sender_id, m.body, m.kind, m.image, m.file_url, m.file_name, m.file_size, m.reply_to, m.created_at,
         u.username AS sender_username, u.display_name AS sender_display_name, u.avatar AS sender_avatar,
         q.body AS reply_body, q.kind AS reply_kind, q.sender_id AS reply_sender
    FROM group_messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN group_messages q ON q.id = m.reply_to`;

/** 是否是群成员 */
export function isGroupMember(groupId, userId) {
  return !!db
    .prepare('SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
}

/** 群的全部成员 id（按入群先后） */
export function groupMemberIds(groupId) {
  return db
    .prepare('SELECT user_id FROM chat_group_members WHERE group_id = ? ORDER BY joined_at, user_id')
    .all(groupId)
    .map((row) => row.user_id);
}

/** 打开群会话时把已读指针推到最新消息 */
export function touchGroupRead(groupId, userId) {
  const latest = db.prepare('SELECT MAX(id) AS n FROM group_messages WHERE group_id = ?').get(groupId).n || 0;
  db.prepare(
    'UPDATE chat_group_members SET last_read_id = MAX(last_read_id, ?) WHERE group_id = ? AND user_id = ?',
  ).run(latest, groupId, userId);
}

/** 群卡片：会话列表只需要的字段（预聚合的 count / unread / last 由 listGroups 传入） */
export function groupOut(row, meId, stats = {}) {
  return {
    id: row.id,
    name: row.name,
    owner_id: row.owner_id,
    official: isOfficialGroup(row.id),
    member_count: stats.memberCount ?? 0,
    unread: stats.unread ?? 0,
    last_message: stats.last
      ? {
          body: stats.last.body,
          kind: stats.last.kind || 'text',
          created_at: stats.last.created_at,
          mine: stats.last.sender_id === meId,
          sender_name: stats.last.sender_display_name || stats.last.sender_username,
        }
      : null,
  };
}

/**
 * 我的群列表：按最后一条群消息时间排序（没聊过的按建群时间）。
 * 与 listFriends 同款聚合风格：三个全量聚合查询替代逐群查三次，避免 N+1。
 */
export function listGroups(meId) {
  const rows = db
    .prepare(
      `SELECT g.id, g.name, g.owner_id
         FROM chat_groups g
         JOIN chat_group_members r ON r.group_id = g.id AND r.user_id = ?
        ORDER BY COALESCE((SELECT MAX(id) FROM group_messages WHERE group_id = g.id), 0) DESC, g.id DESC
        LIMIT 100`,
    )
    .all(meId);
  if (rows.length === 0) return [];

  const countMap = new Map();
  for (const row of db
    .prepare('SELECT group_id, COUNT(*) AS n FROM chat_group_members GROUP BY group_id')
    .all()) {
    countMap.set(row.group_id, row.n);
  }

  const unreadMap = new Map();
  for (const row of db
    .prepare(
      `SELECT gm.group_id, COUNT(*) AS n
         FROM group_messages gm
         JOIN chat_group_members r ON r.group_id = gm.group_id AND r.user_id = ?
        WHERE gm.id > r.last_read_id AND gm.sender_id != ?
        GROUP BY gm.group_id`,
    )
    .all(meId, meId)) {
    unreadMap.set(row.group_id, row.n);
  }

  /** 每个群我参与的最后一条群消息 */
  const lastMap = new Map();
  for (const row of db
    .prepare(
      `${GM_SELECT}
         JOIN ( SELECT MAX(g2.id) AS last_id
                  FROM group_messages g2
                  JOIN chat_group_members r2 ON r2.group_id = g2.group_id AND r2.user_id = ?
                 GROUP BY g2.group_id ) t
           ON t.last_id = m.id`,
    )
    .all(meId)) {
    lastMap.set(row.group_id, row);
  }

  return rows.map((row) =>
    groupOut(row, meId, {
      memberCount: countMap.get(row.id) || 0,
      unread: unreadMap.get(row.id) || 0,
      last: lastMap.get(row.id) || null,
    }),
  );
}
