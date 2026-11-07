import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { config } from '../config.js';
import { hashPassword } from './auth.js';

/**
 * 官方客服账号。
 *
 * 每位玩家都默认和官方客服是好友，遇到问题随时在聊天页提问；
 * 管理员在管理后台的「客服消息」里以这个账号的身份回复。
 *
 * 账号本身不用来登录（密码是随机的），只是私信会话的“另一方”。
 * id 记在 meta 表里，配置里的用户名只在第一次创建 / 找回时使用，
 * 之后就算改配置或改昵称也不会多建一个账号。
 */

let cachedId = 0;

/** 从 meta 里读回已登记的客服 id，账号不在了就当作没登记 */
function storedSupportId() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'support_user_id'").get();
  const id = Number(row?.value || 0);
  if (!id) return 0;
  return db.prepare('SELECT id FROM users WHERE id = ?').get(id) ? id : 0;
}

/**
 * 确保官方客服账号存在，返回它的 id。
 * 第一次启动时会按 SUPPORT_USERNAME / SUPPORT_DISPLAY_NAME 创建。
 */
export function ensureSupportUser() {
  if (cachedId > 0) return cachedId;

  const stored = storedSupportId();
  if (stored > 0) {
    cachedId = stored;
    return cachedId;
  }

  let row = db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(config.support.username);
  if (!row) {
    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO users (username, display_name, bio, role, status, pass_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, 'user', 'active', ?, ?, ?)`,
      )
      .run(
        config.support.username,
        config.support.displayName,
        config.support.bio,
        hashPassword(crypto.randomUUID()),   // 随机密码，客服账号不用于登录
        timestamp,
        timestamp,
      );
    row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
    console.log(`[论坛] 已创建官方客服账号：${row.username}（#${row.id}）`);
  }

  cachedId = row.id;
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('support_user_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(row.id));
  return cachedId;
}

/** 客服账号 id（不存在时按配置创建） */
export function supportUserId() {
  return ensureSupportUser();
}

/** 这个 id 是不是官方客服 */
export function isSupportUser(userId) {
  return Number(userId) > 0 && Number(userId) === ensureSupportUser();
}

/**
 * 确保某位玩家和客服是好友（默认好友，不需要申请）。
 * 用户曾经主动删掉过、或先给客服发过申请，下次打开好友页都会自动恢复成好友。
 */
export function ensureSupportFriend(userId) {
  const supportId = ensureSupportUser();
  const uid = Number(userId);
  if (!uid || uid === supportId) return;

  const existing = db
    .prepare(
      `SELECT * FROM friendships
        WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
    )
    .get(supportId, uid, uid, supportId);

  const timestamp = now();
  if (!existing) {
    db.prepare(
      `INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
    ).run(supportId, uid, timestamp, timestamp);
    return;
  }
  if (existing.status !== 'accepted') {
    db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?").run(timestamp, existing.id);
  }
}

/**
 * 启动时给所有已有用户补上客服好友。
 * 一条 INSERT ... SELECT 搞定，几万用户也不会卡启动。
 */
export function ensureAllSupportFriends() {
  const supportId = ensureSupportUser();
  const timestamp = now();

  db.prepare(
    `INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at)
     SELECT ?, u.id, 'accepted', ?, ?
       FROM users u
      WHERE u.id != ?
        AND NOT EXISTS (
          SELECT 1 FROM friendships f
           WHERE (f.requester_id = ? AND f.addressee_id = u.id)
              OR (f.requester_id = u.id AND f.addressee_id = ?)
        )`,
  ).run(supportId, timestamp, timestamp, supportId, supportId, supportId);

  // 之前玩家先给客服发过申请（或客服被申请成待通过）的，直接结为好友
  db.prepare(
    `UPDATE friendships SET status = 'accepted', updated_at = ?
      WHERE status != 'accepted' AND (requester_id = ? OR addressee_id = ?)`,
  ).run(timestamp, supportId, supportId);
}
