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

  // 访问统计：记录页面浏览、统计日活 / 月活。
  // 明细保留天数决定能查多久的趋势（默认 400 天，够算月活和同比）；
  // 盐值换了以后旧访客会被当成新访客，换之前请想清楚。
  visitTracking: bool(env.VISIT_TRACKING, true),
  visitRetentionDays: Math.max(7, num(env.VISIT_RETENTION_DAYS, 400)),
  visitSalt: env.VISIT_SALT || 'blockbox-forum',

  maxBodyBytes: num(env.MAX_BODY_BYTES, 256 * 1024),
  maxAvatarBytes: num(env.MAX_AVATAR_BYTES, 512 * 1024),
  maxCoverBytes: num(env.MAX_COVER_BYTES, 3 * 1024 * 1024),
  maxImageBytes: num(env.MAX_IMAGE_BYTES, 4 * 1024 * 1024),

  // 图片处理：原图长边上限、缩略图长边上限、头像边长
  imageMaxDimension: num(env.MAX_IMAGE_DIMENSION, 2560),
  thumbSize: num(env.THUMB_SIZE, 520),
  avatarSize: num(env.AVATAR_SIZE, 256),
  coverMaxDimension: num(env.MAX_COVER_DIMENSION, 1920),

  adminBootstrapUser: (env.ADMIN_BOOTSTRAP_USER || '').trim(),
  adminBootstrapPass: env.ADMIN_BOOTSTRAP_PASS || '',

  // 邮件发送（邮箱验证码用）：SMTP_HOST 留空表示不启用，相关接口会明确提示未配置。
  // 465 端口用隐式 TLS（SMTP_SECURE=1）；587 端口配 SMTP_SECURE=0，会自动升级 STARTTLS
  smtpHost: (env.SMTP_HOST || '').trim(),
  smtpPort: num(env.SMTP_PORT, 465),
  smtpSecure: bool(env.SMTP_SECURE, true),
  smtpUser: (env.SMTP_USER || '').trim(),
  smtpPass: env.SMTP_PASS || '',
  mailFrom: (env.MAIL_FROM || '').trim(),
  // 外部 SMTP 服务器用自签名证书时设 1（连本机 Postfix 不用配，自动信任）
  smtpAllowSelfSigned: bool(env.SMTP_ALLOW_SELF_SIGNED, false),
};
