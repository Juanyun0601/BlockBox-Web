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
         u.muted_until, u.mute_scope, u.mute_reason,
         u.thread_count, u.post_count, u.quiz_passed_at, u.quiz_best_score,
         u.email_verified_at, u.created_at, u.last_seen_at,
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

/** 是否管理员级（管理员 / 次级管理员都算） */
export function isAdminRole(role) {
  return role === 'admin' || role === 'moderator';
}

/** 管理后台各功能：管理员和次级管理员都能用 */
export function requireAdmin(user) {
  requireUser(user);
  if (!isAdminRole(user.role)) throw forbidden('需要管理员权限');
  return user;
}

/** 只有真正的管理员能做（如设置别人的管理员权限），次级管理员不行 */
export function requireHeadAdmin(user) {
  requireUser(user);
  if (user.role !== 'admin') throw forbidden('只有管理员才能设置管理权限');
  return user;
}

/** 发帖 / 回复前检查账号状态 */
export function assertCanPost(user, kind = 'thread') {
  requireUser(user);
  const mute = muteError(user, kind);
  if (mute) throw mute;
  // 入站答题和账号绑定：没通过的账号不能发帖、不能回复
  if (!user.quiz_passed_at) {
    throw new HttpError(403, '发帖或回复前，需要先通过入站答题', 'quiz_required');
  }
  return user;
}

/** 禁言能管到的内容：thread 发帖 / reply 回复 / dm 私信；all 表示全部都禁 */
export const MUTE_SCOPES = ['thread', 'reply', 'dm'];

const MUTE_SCOPE_LABELS = { thread: '发帖', reply: '回复', dm: '私信' };

/** 把数据库里的 mute_scope 拆成范围列表（空 / all 都表示全部） */
export function muteScopeList(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw || raw === 'all') return MUTE_SCOPES.slice();
  const picked = raw.split(/[,\s]+/).filter((item) => MUTE_SCOPES.includes(item));
  return MUTE_SCOPES.filter((scope) => picked.includes(scope));
}

/** 归一化成存库的写法：全选存 all，否则存 thread,reply 这样的列表 */
export function normalizeMuteScope(value) {
  const list = muteScopeList(value);
  return list.length === MUTE_SCOPES.length ? 'all' : list.join(',');
}

/** 禁言范围的中文说法，用在提示语里 */
export function muteScopeLabel(value) {
  return muteScopeList(value)
    .map((scope) => MUTE_SCOPE_LABELS[scope])
    .join('、');
}

/** 禁言是否还在生效（永久禁言 muted_until 为 0） */
export function muteActive(user) {
  if (!user || user.status !== 'muted') return false;
  const until = Number(user.muted_until || 0);
  return until === 0 || until > now();
}

/** 服务器本地时间：2026-11-01 20:42（禁言提示里给人看的时间） */
function localTime(seconds) {
  const d = new Date(Number(seconds) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 被禁言时返回要抛出的错误，没被禁言返回 null。
 * kind：thread 发帖 / reply 回复 / dm 私信
 */
export function muteError(user, kind = 'thread') {
  requireUser(user);
  if (user.status === 'banned') throw forbidden('该账号已被封禁，无法发言');
  if (!muteActive(user)) return null;
  if (!muteScopeList(user.mute_scope).includes(kind)) return null;

  const until = Number(user.muted_until || 0)
    ? `${localTime(user.muted_until)} 解除`
    : '管理员解除为止';
  const reason = String(user.mute_reason || '').trim();
  return new HttpError(
    403,
    `账号已被禁言：禁止${muteScopeLabel(user.mute_scope)}（${until}）${reason ? `，理由：${reason}` : ''}`,
    'muted',
  );
}

/** 对外输出的用户信息（不含邮箱哈希等敏感字段） */
export function publicUser(row, { self = false } = {}) {
  if (!row) return null;
  // 到期未处理的禁言按正常显示，避免列表里一直挂着「禁言」
  const expired = !muteActive(row) && row.status === 'muted';
  const data = {
    id: row.id,
    username: row.username,
    display_name: row.display_name || row.username,
    bio: row.bio || '',
    avatar: row.avatar || '',
    cover: row.cover || '',
    role: row.role,
    status: expired ? 'active' : row.status,
    muted_until: expired ? 0 : row.muted_until || 0,
    thread_count: row.thread_count || 0,
    post_count: row.post_count || 0,
    quiz_passed: !!row.quiz_passed_at,
    quiz_passed_at: row.quiz_passed_at || 0,
    quiz_best_score: row.quiz_best_score ?? -1,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at || 0,
  };
  if (self || isAdminRole(row.role)) {
    data.email = row.email || '';
    data.email_verified = !!row.email_verified_at;
    data.mute_scope = row.mute_scope || 'all';
    data.mute_reason = row.mute_reason || '';
    data.mute_by = row.mute_by || '';
  }
  return data;
}
