import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { badRequest } from './http.js';
import { sanitizeFileName } from './chat-files.js';

/**
 * 反馈日志（启动器问题反馈页「一键上传日志」传上来的运行日志）：
 * - 单份上限 config.maxLogBytes（默认 5MB），超出让用户先看启动器端提示；
 * - 落盘到 uploads/log/，登记进 uploads 表（kind = 'log'，meta 存原始文件名与启动器版本）；
 * - 链接与普通上传一样按路径直接可访问，文件名带随机段，不靠猜枚举。
 */

/** 保存一份运行日志，返回 { url, name, size }（url 为 /uploads/log/… 站内路径） */
export function saveLogFile(buffer, { userId, originalName, appVersion }) {
  if (!buffer || buffer.length <= 0) throw badRequest('日志内容为空');
  if (buffer.length > config.maxLogBytes) {
    throw badRequest(`日志太大了，请压缩到 ${Math.round(config.maxLogBytes / 1024 / 1024)} MB 以内`, 'log_too_large');
  }

  const name = sanitizeFileName(originalName) || 'launcher.log';
  const version = String(appVersion || '').slice(0, 40);
  const filename = `log-${userId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.log`;
  const logDir = path.join(config.uploadDir, 'log');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, filename), buffer);

  db.prepare(
    `INSERT INTO uploads (user_id, url, thumb, mime, width, height, size, kind, meta, created_at)
     VALUES (?, ?, NULL, 'text/plain', 0, 0, ?, 'log', ?, ?)`,
  ).run(userId, `/uploads/log/${filename}`, buffer.length, JSON.stringify({ name, version }), now());

  return { url: `/uploads/log/${filename}`, name, size: buffer.length };
}
