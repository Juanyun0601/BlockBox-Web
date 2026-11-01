import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { config } from '../config.js';
import { HttpError, forbidden, unauthorized, serializeCookie } from './http.js';

export const SESSION_COOKIE = 'bbf_sid';

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** 生成密码哈希，格式 s1$盐$哈希（scrypt） */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 's1') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createSession(userId, { ip = '', ua = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = now();
  const expiresAt = createdAt + config.sessionDays * 86400;
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(token, userId, createdAt, expiresAt, String(ip).slice(0, 64), String(ua).slice(0, 200));
  return { token, expiresAt };
}

const SESSION_USER_SQL = `
  SELECT u.id, u.username, u.display_name, u.email, u.bio, u.avatar, u.cover, u.role, u.status,
         u.muted_until, u.thread_count, u.post_count, u.quiz_passed_at, u.quiz_best_score,
         u.created_at, u.last_seen_at,
         s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
   WHERE s.token = ? AND s.expires_at > ?`;

/** 用 token 换用户，顺手刷新最近活跃时间（5 分钟一次） */
export function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(SESSION_USER_SQL).get(token, now());
  if (!row) return null;
  const current = now();
  if (current - row.last_seen_at > 300) {
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(current, row.id);
    row.last_seen_at = current;
  }
  return row;
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function sessionCookie(res, token, expiresAt) {
  const maxAge = Math.max(60, expiresAt - now());
  res.setHeader(
    'set-cookie',
    serializeCookie(SESSION_COOKIE, token, {
      maxAge,
      secure: config.secureCookie,
      sameSite: 'Lax',
    }),
  );
}

export function clearSessionCookie(res) {
  res.setHeader(
    'set-cookie',
    serializeCookie(SESSION_COOKIE, '', {
      maxAge: 0,
      secure: config.secureCookie,
      sameSite: 'Lax',
    }),
  );
}

export function requireUser(user) {
  if (!user) throw unauthorized();
  return user;
}

export function requireAdmin(user) {
  requireUser(user);
  if (user.role !== 'admin') throw forbidden('需要管理员权限');
  return user;
}

/** 发帖 / 回复前检查账号状态 */
export function assertCanPost(user) {
  requireUser(user);
  if (user.status === 'banned') throw forbidden('该账号已被封禁，无法发言');
  if (user.status === 'muted' && (user.muted_until === 0 || user.muted_until > now())) {
    const until = user.muted_until
      ? new Date(user.muted_until * 1000).toISOString().slice(0, 16).replace('T', ' ')
      : '管理员解除为止';
    throw new HttpError(403, `账号已被禁言（${until}）`, 'muted');
  }
  // 入站答题和账号绑定：没通过的账号不能发帖、不能回复
  if (!user.quiz_passed_at) {
    throw new HttpError(403, '发帖或回复前，需要先通过入站答题', 'quiz_required');
  }
  return user;
}

/** 对外输出的用户信息（不含邮箱哈希等敏感字段） */
export function publicUser(row, { self = false } = {}) {
  if (!row) return null;
  const data = {
    id: row.id,
    username: row.username,
    display_name: row.display_name || row.username,
    bio: row.bio || '',
    avatar: row.avatar || '',
    cover: row.cover || '',
    role: row.role,
    status: row.status,
    muted_until: row.muted_until || 0,
    thread_count: row.thread_count || 0,
    post_count: row.post_count || 0,
    quiz_passed: !!row.quiz_passed_at,
    quiz_passed_at: row.quiz_passed_at || 0,
    quiz_best_score: row.quiz_best_score ?? -1,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at || 0,
  };
  if (self || row.role === 'admin') data.email = row.email || '';
  return data;
}
