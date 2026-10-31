import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 工程根目录（server/ 的上一级） */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 读取 .env（不覆盖已存在的环境变量），格式：KEY=VALUE，支持 # 注释与引号 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT_DIR, '.env'));

const env = process.env;
const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (value, fallback) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);
const resolvePath = (value) => (path.isAbsolute(value) ? value : path.join(ROOT_DIR, value));

export const config = {
  host: env.HOST || '127.0.0.1',
  port: num(env.PORT, 3210),

  siteName: env.SITE_NAME || '方块盒子论坛',
  siteDesc:
    env.SITE_DESC ||
    '方块盒子官方玩家社区：使用求助、玩法分享、插件开发与建议反馈',

  dbPath: resolvePath(env.DB_PATH || 'data/forum.db'),
  uploadDir: resolvePath(env.UPLOAD_DIR || 'data/uploads'),
  webDir: resolvePath(env.WEB_DIR || 'web'),

  publicOrigin: (env.PUBLIC_ORIGIN || '').replace(/\/+$/, ''),
  allowedOrigins: (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean),

  sessionDays: num(env.SESSION_DAYS, 30),
  registerOpen: bool(env.REGISTER_OPEN, true),
  trustProxy: bool(env.TRUST_PROXY, false),
  secureCookie: bool(env.SECURE_COOKIE, false),
  logRequests: bool(env.LOG_REQUESTS, true),

  maxBodyBytes: num(env.MAX_BODY_BYTES, 256 * 1024),
  maxAvatarBytes: num(env.MAX_AVATAR_BYTES, 512 * 1024),
  maxImageBytes: num(env.MAX_IMAGE_BYTES, 4 * 1024 * 1024),

  // 图片处理：原图长边上限、缩略图长边上限、头像边长
  imageMaxDimension: num(env.MAX_IMAGE_DIMENSION, 2560),
  thumbSize: num(env.THUMB_SIZE, 520),
  avatarSize: num(env.AVATAR_SIZE, 256),

  adminBootstrapUser: (env.ADMIN_BOOTSTRAP_USER || '').trim(),
  adminBootstrapPass: env.ADMIN_BOOTSTRAP_PASS || '',
};
