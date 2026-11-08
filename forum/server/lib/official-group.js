import { db, now } from '../db.js';
import { config } from '../config.js';
import { supportUserId } from './support.js';

/**
 * 官方全用户群「方块盒子全用户讨论群」。
 *
 * 每位玩家都默认在这个群里，注册即入群、打开好友页也会自动补上；
 * 和官方客服好友一样属于"官方默认会话"，不能退出。
 * 群主挂靠在官方客服账号上（它无法登录，"群主退出即解散"永远不触发）。
 *
 * 群 id 记在 meta 表里，配置里的群名只在第一次创建时使用，
 * 之后就算改名配置也不会多建一个群；群被误删会在下次启动 / 打开好友页时自动重建。
 */

let cachedId = 0;

/** 从 meta 里读回已登记的官方群 id，群不在了就当作没登记 */
function storedGroupId() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'official_group_id'").get();
  const id = Number(row?.value || 0);
  if (!id) return 0;
  return db.prepare('SELECT id FROM chat_groups WHERE id = ?').get(id) ? id : 0;
}

/**
 * 确保官方群存在，返回它的 id。
 * 第一次启动时创建，群主是官方客服账号，并发一条欢迎消息撑起会话预览。
 */
export function ensureOfficialGroup() {
  if (cachedId > 0) return cachedId;

  const stored = storedGroupId();
  if (stored > 0) {
    cachedId = stored;
    return cachedId;
  }

  const ownerId = supportUserId();
  const timestamp = now();
  const result = db
    .prepare('INSERT INTO chat_groups (name, owner_id, created_at) VALUES (?, ?, ?)')
    .run(config.officialGroup.name, ownerId, timestamp);
  cachedId = Number(result.lastInsertRowid);
  db.prepare(
    'INSERT INTO chat_group_members (group_id, user_id, last_read_id, joined_at) VALUES (?, ?, 0, ?)',
  ).run(cachedId, ownerId, timestamp);
  if (config.officialGroup.welcome) {
    db.prepare(
      `INSERT INTO group_messages (group_id, sender_id, body, kind, created_at)
       VALUES (?, ?, ?, 'text', ?)`,
    ).run(cachedId, ownerId, config.officialGroup.welcome, timestamp);
  }

  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('official_group_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(cachedId));
  console.log(`[论坛] 已创建官方全用户群：${config.officialGroup.name}（#${cachedId}）`);
  return cachedId;
}

/** 官方群 id（不存在时按配置创建） */
export function officialGroupId() {
  return ensureOfficialGroup();
}

/** 这个群是不是官方全用户群 */
export function isOfficialGroup(groupId) {
  return Number(groupId) > 0 && Number(groupId) === officialGroupId();
}

/**
 * 确保某位玩家在官方群里（默认成员，不需要任何人邀请）。
 * 之前不管因为什么原因不在群里（误删、群重建过），下次打开好友页都会自动回来。
 * 入群时把已读指针推到当时的最新消息，入群前的旧消息不计未读。
 */
export function ensureOfficialGroupMember(userId) {
  const groupId = officialGroupId();
  const uid = Number(userId);
  if (!uid) return;

  const latestId = db.prepare('SELECT MAX(id) AS n FROM group_messages WHERE group_id = ?').get(groupId).n || 0;
  db.prepare(
    `INSERT INTO chat_group_members (group_id, user_id, last_read_id, joined_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id, user_id) DO NOTHING`,
  ).run(groupId, uid, latestId, now());
}

/**
 * 启动时给所有已有用户补上官方群成员关系。
 * 一条 INSERT ... SELECT 搞定，几万用户也不会卡启动。
 */
export function ensureAllOfficialGroupMembers() {
  const groupId = officialGroupId();
  const latestId = db.prepare('SELECT MAX(id) AS n FROM group_messages WHERE group_id = ?').get(groupId).n || 0;
  const timestamp = now();

  db.prepare(
    `INSERT INTO chat_group_members (group_id, user_id, last_read_id, joined_at)
     SELECT ?, u.id, ?, ?
       FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_group_members r
         WHERE r.group_id = ? AND r.user_id = u.id
      )`,
  ).run(groupId, latestId, timestamp, groupId);
}
