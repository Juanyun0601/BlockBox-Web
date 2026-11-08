import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { badRequest } from './http.js';

/**
 * 聊天文件（私聊 / 群聊共用的附件）：
 * - 单文件上限 config.maxChatFileBytes（默认 5MB）；
 * - 拦截常见可执行文件类型，其余类型都放行；
 * - 落盘到 uploads/chat/，登记进 uploads 表（kind = 'chat'，meta 存原始文件名），
 *   发消息时以表里的记录为准，不信任客户端报的路径和大小。
 * - 每人每周 30MB「下载提取流量」：下载别人发的文件才扣，图片显示和自己下载自己的不算。
 */

/** 拒绝发送的可执行类扩展名（小写），mod 常用的 jar / zip 不在拦截之列 */
const BLOCKED_EXTENSIONS = new Set(['exe', 'msi', 'bat', 'cmd', 'scr', 'vbs', 'com', 'pif', 'cpl']);

/** 文件名最长保留多少字符（超长截断，保留扩展名） */
const MAX_NAME_CHARS = 80;

/** 把客户端给的原始文件名洗成安全的展示名：去路径、去控制字符、限长 */
export function sanitizeFileName(raw) {
  const base = String(raw || '')
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .replace(/["<>|?*:]/g, '')
    .trim();
  if (!base || base === '.' || base === '..') return '';
  if (base.length <= MAX_NAME_CHARS) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, MAX_NAME_CHARS - ext.length);
  return stem + ext;
}

/** 聊天文件原始文件名是否允许发送（扩展名黑名单） */
export function isBlockedFileName(name) {
  const ext = path.extname(String(name || '')).replace(/^\./, '').toLowerCase();
  return BLOCKED_EXTENSIONS.has(ext);
}

/** 保存一个聊天文件，返回 { url, name, size }（url 为 /uploads/chat/… 站内路径） */
export function saveChatFile(buffer, { userId, originalName }) {
  if (!buffer || buffer.length <= 0) throw badRequest('文件内容为空');
  if (buffer.length > config.maxChatFileBytes) {
    throw badRequest(`文件太大了，请压缩到 ${Math.round(config.maxChatFileBytes / 1024 / 1024)} MB 以内`, 'chat_file_too_large');
  }

  const name = sanitizeFileName(originalName);
  if (!name) throw badRequest('文件名无效');
  if (isBlockedFileName(name)) throw badRequest('不支持发送可执行文件（exe / msi / bat 等）', 'chat_file_type');

  const ext = path.extname(name).replace(/^\./, '').toLowerCase().slice(0, 10);
  const filename = `chat-${userId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext ? `.${ext}` : ''}`;
  const chatDir = path.join(config.uploadDir, 'chat');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, filename), buffer);

  db.prepare(
    `INSERT INTO uploads (user_id, url, thumb, mime, width, height, size, kind, meta, created_at)
     VALUES (?, ?, NULL, ?, 0, 0, ?, 'chat', ?, ?)`,
  ).run(userId, `/uploads/chat/${filename}`, guessMime(name), buffer.length, JSON.stringify({ name }), now());

  return { url: `/uploads/chat/${filename}`, name, size: buffer.length };
}

/** 查一条聊天文件的上传记录（必须存在、未删除、kind=chat、属于 userId） */
export function findOwnChatFile(url, userId) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/chat/') || url.includes('..')) return null;
  return (
    db
      .prepare("SELECT url, size, meta FROM uploads WHERE url = ? AND user_id = ? AND kind = 'chat' AND deleted = 0")
      .get(url, userId) || null
  );
}

/** 从 uploads.meta 里取回原始文件名 */
export function chatFileDisplayName(row) {
  try {
    return String(JSON.parse(row.meta || '{}').name || '');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------ 每周下载流量

/** 本周一 0 点（服务器本地时区）的 unix 秒 */
export function currentWeekStart() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // 周一 = 0
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  return Math.floor(monday.getTime() / 1000);
}

/** 我本周已用的下载流量（字节） */
export function weeklyUsage(userId) {
  const row = db
    .prepare('SELECT bytes FROM chat_download_usage WHERE user_id = ? AND week_start = ?')
    .get(userId, currentWeekStart());
  return row ? row.bytes : 0;
}

/** 剩余流量（字节） */
export function remainingQuota(userId) {
  return Math.max(0, config.chatWeeklyQuotaBytes - weeklyUsage(userId));
}

/**
 * 下载一个文件前记账：size 字节从本周流量里扣。
 * 返回 { ok, remaining }；不够时 ok = false，不扣。
 * isOwn = true 表示下载自己发的文件，直接放行不扣。
 */
export function consumeQuota(userId, size, { isOwn = false } = {}) {
  if (isOwn) return { ok: true, remaining: remainingQuota(userId) };
  const used = weeklyUsage(userId);
  const left = config.chatWeeklyQuotaBytes - used;
  if (size > left) {
    return { ok: false, remaining: Math.max(0, left) };
  }
  const week = currentWeekStart();
  db.prepare(
    `INSERT INTO chat_download_usage (user_id, week_start, bytes) VALUES (?, ?, ?)
      ON CONFLICT(user_id, week_start) DO UPDATE SET bytes = bytes + excluded.bytes`,
  ).run(userId, week, size);
  // 顺手清掉两周前的旧账，表不会一直涨
  db.prepare('DELETE FROM chat_download_usage WHERE week_start < ?').run(week - 14 * 86400);
  return { ok: true, remaining: left - size };
}

/** 按扩展名猜一个大概的 mime（仅存档用，静态服务另有自己的映射） */
function guessMime(name) {
  const ext = path.extname(name).toLowerCase();
  const table = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.jar': 'application/java-archive',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  };
  return table[ext] || 'application/octet-stream';
}
