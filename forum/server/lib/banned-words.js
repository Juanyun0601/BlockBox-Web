import { db, now } from '../db.js';
import { HttpError, badRequest, notFound } from './http.js';
import { localTime, isAdminRole, muteActive } from './auth.js';
import { notifyAdminMessage } from './notify.js';

/**
 * 违禁词：管理后台「审核」页维护的拦截规则。
 * 一条规则 = 违禁词 + 违禁原因 + 封禁时长（命中后自动禁言多久）。
 * 只检查发帖 / 回复（含修改后的内容），私信与群聊不拦。
 */

/** 规则条数上限：每次发帖都要逐条比对，别让列表无限制长下去 */
export const MAX_BANNED_WORDS = 200;
const MAX_WORD_LENGTH = 30;
const MAX_REASON_LENGTH = 100;
/** 一条规则最多禁言一年；0 表示永久（管理员手动解除） */
export const MAX_BAN_HOURS = 24 * 365;
const DEFAULT_BAN_HOURS = 24;
/** 自动禁言时记在「操作人」里的名字，用户管理页能看到 */
export const AUTO_MUTE_BY = '自动审核（违禁词）';

/** 零宽字符：粘贴或复制时常混进来，比对前统一去掉，免得用「违」+零宽+「禁」绕过去 */
const ZERO_WIDTH_RE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

/** 比对用的文本：去掉零宽字符、统一小写（中文不受影响，英文不分大小写） */
function normalize(value) {
  return String(value == null ? '' : value).replace(ZERO_WIDTH_RE, '').toLowerCase();
}

/** 违禁词存库前的清洗 */
function cleanWord(value) {
  const word = String(value == null ? '' : value)
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!word) throw badRequest('违禁词不能为空');
  if ([...word].length > MAX_WORD_LENGTH) throw badRequest(`违禁词最多 ${MAX_WORD_LENGTH} 个字`);
  return word;
}

function cleanReason(value) {
  const reason = String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if ([...reason].length > MAX_REASON_LENGTH) throw badRequest(`违禁原因最多 ${MAX_REASON_LENGTH} 个字`);
  return reason;
}

/** 封禁时长（小时）：0 表示永久，其余换算成到期时间 */
function cleanHours(value, fallback = DEFAULT_BAN_HOURS) {
  if (value === undefined || value === null || value === '') return fallback;
  const hours = Math.floor(Number(value));
  if (!Number.isFinite(hours)) throw badRequest('封禁时长不正确');
  if (hours < 0) throw badRequest('封禁时长不能是负数');
  if (hours > MAX_BAN_HOURS) throw badRequest(`封禁时长最多 ${MAX_BAN_HOURS} 小时`);
  return hours;
}

function outWord(row) {
  if (!row) return null;
  return {
    id: row.id,
    word: row.word,
    reason: row.reason || '',
    ban_hours: Number(row.ban_hours || 0),
    enabled: !!row.enabled,
    hits: Number(row.hits || 0),
    last_hit_at: Number(row.last_hit_at || 0),
    created_by: row.created_by || '',
    created_at: row.created_at,
  };
}

/** 后台列表：新的在前 */
export function listBannedWords() {
  return db
    .prepare('SELECT * FROM banned_words ORDER BY id DESC')
    .all()
    .map(outWord);
}

/**
 * 生效中的规则，长的排前面：
 * 同时命中「广告」和「代练广告」时，用更具体的那条来定理由和时长。
 */
function activeRules() {
  return db
    .prepare('SELECT * FROM banned_words WHERE enabled = 1')
    .all()
    .map((row) => ({ ...row, key: normalize(row.word).replace(/\s+/g, ' ').trim() }))
    .filter((row) => row.key)
    .sort((a, b) => b.key.length - a.key.length);
}

/** 从一段文字里找出命中的违禁词，没命中返回 null */
export function findBannedWord(content) {
  const text = normalize(content).replace(/\s+/g, ' ');
  if (!text) return null;
  for (const rule of activeRules()) {
    if (text.includes(rule.key)) return outWord(rule);
  }
  return null;
}

export function addBannedWord({ word, reason, hours, admin }) {
  const clean = cleanWord(word);
  const total = db.prepare('SELECT COUNT(*) AS n FROM banned_words').get().n;
  if (total >= MAX_BANNED_WORDS) throw badRequest(`最多只能设置 ${MAX_BANNED_WORDS} 个违禁词`);
  if (db.prepare('SELECT id FROM banned_words WHERE word = ?').get(clean)) {
    throw badRequest('这个违禁词已经设置过了');
  }
  const result = db
    .prepare(
      'INSERT INTO banned_words (word, reason, ban_hours, enabled, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?)',
    )
    .run(
      clean,
      cleanReason(reason),
      cleanHours(hours),
      String(admin?.display_name || admin?.username || '').slice(0, 40),
      now(),
    );
  return outWord(db.prepare('SELECT * FROM banned_words WHERE id = ?').get(Number(result.lastInsertRowid)));
}

export function updateBannedWord(id, patch = {}) {
  const row = db.prepare('SELECT * FROM banned_words WHERE id = ?').get(Number(id));
  if (!row) throw notFound('违禁词不存在');

  const word = patch.word === undefined ? row.word : cleanWord(patch.word);
  const reason = patch.reason === undefined ? row.reason : cleanReason(patch.reason);
  const banHours = patch.hours === undefined ? Number(row.ban_hours || 0) : cleanHours(patch.hours, 0);
  const enabled = patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0;

  if (word !== row.word && db.prepare('SELECT id FROM banned_words WHERE word = ? AND id != ?').get(word, row.id)) {
    throw badRequest('这个违禁词已经设置过了');
  }

  db.prepare('UPDATE banned_words SET word = ?, reason = ?, ban_hours = ?, enabled = ? WHERE id = ?').run(
    word,
    reason,
    banHours,
    enabled,
    row.id,
  );
  return outWord(db.prepare('SELECT * FROM banned_words WHERE id = ?').get(row.id));
}

export function removeBannedWord(id) {
  const row = db.prepare('SELECT * FROM banned_words WHERE id = ?').get(Number(id));
  if (!row) throw notFound('违禁词不存在');
  db.prepare('DELETE FROM banned_words WHERE id = ?').run(row.id);
  return outWord(row);
}

/** 禁言说法：2026-11-15 20:00 解除 / 管理员解除为止 */
function untilText(until) {
  return Number(until) ? `${localTime(until)} 解除` : '管理员解除为止';
}

/**
 * 内容命中违禁词就拦下（抛 403，code = banned_word）。
 * 普通玩家还会被按规则自动禁言：禁止全部发言，到时间自动恢复。
 * 管理员和次级管理员照样拦内容，但不会禁自己人的言。
 * 返回 null 表示没命中，可以继续。
 */
export function guardBannedWords(user, content, { action = '发帖' } = {}) {
  if (!user) return null;
  const rule = findBannedWord(content);
  if (!rule) return null;

  const timestamp = now();
  db.prepare('UPDATE banned_words SET hits = hits + 1, last_hit_at = ? WHERE id = ?').run(timestamp, rule.id);

  const reason = String(rule.reason || '').trim();
  const base = `内容包含违禁词「${rule.word}」，${action}已拦下。`;

  // 管理员不受自动禁言影响，只拦内容
  if (isAdminRole(user.role)) throw new HttpError(403, base, 'banned_word');
  // 已经在禁言 / 封禁中：内容照样拦，不重复处罚，也不缩短原来的处罚
  if (user.status === 'banned') throw new HttpError(403, base, 'banned_word');
  if (muteActive(user)) throw new HttpError(403, `${base}账号当前仍在禁言中。`, 'banned_word');

  const hours = Number(rule.ban_hours || 0);
  const until = hours > 0 ? timestamp + hours * 3600 : 0;

  db.prepare(
    'UPDATE users SET status = ?, muted_until = ?, mute_scope = ?, mute_reason = ?, mute_by = ? WHERE id = ?',
  ).run('muted', until, 'all', reason || `内容包含违禁词「${rule.word}」`, AUTO_MUTE_BY, user.id);

  // 账号上只存一份理由，这里同步给当前请求，后面再拿到的用户信息才对得上
  user.status = 'muted';
  user.muted_until = until;
  user.mute_scope = 'all';
  user.mute_reason = reason || `内容包含违禁词「${rule.word}」`;

  try {
    notifyAdminMessage(
      user.id,
      '账号已被自动禁言',
      `你在${action}时使用了违禁词「${rule.word}」，内容已被拦下。` +
        `账号禁止全部发言，${untilText(until)}${reason ? `。理由：${reason}` : '。'}` +
        '如有疑问可以联系管理员。',
    );
  } catch (error) {
    console.error('[论坛] 违禁词自动禁言通知发送失败：', error.message);
  }

  throw new HttpError(
    403,
    `${base}账号已被禁言，${untilText(until)}${reason ? `，理由：${reason}` : ''}`,
    'banned_word',
  );
}
