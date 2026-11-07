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

/** CDN 地址只接受 http(s)://域名[:端口]；带了路径或参数就当没填，免得静态资源改错根 */
const normalizeOrigin = (value) => {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
};

/**
 * 启动器首页公告文件：
 * - 显式配了 ANNOUNCEMENT_FILE 就用它；
 * - 服务器上有官网目录 /var/www/blockbox 时，默认写官网根目录的 announcement.json；
 * - 本地开发没有这个目录，就用仓库里的 方块盒子官网/announcement.json（论坛的上一级）。
 */
const SITE_DIR = '/var/www/blockbox';
const defaultAnnouncementFile = fs.existsSync(SITE_DIR)
  ? path.join(SITE_DIR, 'announcement.json')
  : path.resolve(ROOT_DIR, '..', 'announcement.json');

const cdnBaseValue = normalizeOrigin(env.CDN_BASE);

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

  // 启动器公告文件：管理后台的「首页公告 / 启动重要公告」发布后都写到这里，客户端会定时拉取。
  // 默认 /var/www/blockbox/announcement.json（服务器）或仓库里的那份（本地）。
  announcementFile: env.ANNOUNCEMENT_FILE ? resolvePath(env.ANNOUNCEMENT_FILE) : defaultAnnouncementFile,

  publicOrigin: (env.PUBLIC_ORIGIN || '').replace(/\/+$/, ''),

  // CDN：把公开资源（/assets/ 静态文件、/uploads/ 图片）交给 CDN 域名去发。
  // 只填协议 + 域名，例如 https://cdn.mcblockbox.top；留空表示仍由论坛自己提供。
  cdnBase: normalizeOrigin(env.CDN_BASE),
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
  // 论坛插件帖的插件包（.BlockBox，实为 zip）上限
  maxPluginBytes: num(env.MAX_PLUGIN_BYTES, 20 * 1024 * 1024),
  // 版本发布的安装包上限（Windows 安装版接近 100MB，留裕量）
  maxReleaseFileBytes: num(env.MAX_RELEASE_FILE_BYTES, 300 * 1024 * 1024),
  // 版本安装包目录：管理后台上传，官网与启动器经 /releases/files/<版本>/<文件名> 下载
  releaseDir: resolvePath(env.RELEASE_DIR || 'data/releases'),
  // 官网安装包下载限速：每个下载请求最多多少 KB/s（0 表示不限速）。
  // 官网直链和启动器应用内更新都算在内，用来压住服务器出口带宽与月流量。
  downloadRateLimitKb: Math.max(0, num(env.DOWNLOAD_RATE_LIMIT_KB, 400)),
  // 启动器直链前缀：拼进 /api/app/releases 的 browser_download_url，让安装包下载走 CDN。
  // 优先显式配置；没配则沿用 CDN 域名，再退到论坛自身对外地址；都为空时给相对路径
  publicDownloadsBase:
    normalizeOrigin(env.PUBLIC_DOWNLOADS_BASE) || cdnBaseValue || (env.PUBLIC_ORIGIN || '').replace(/\/+$/, ''),
  // 官网一键下载的验证跳转域（与论坛同域才能复用已过验证的 Cookie）。
  // 优先显式配置；没配则用论坛对外地址，再退到 CDN 域名
  publicGateBase:
    normalizeOrigin(env.PUBLIC_GATE_BASE) || (env.PUBLIC_ORIGIN || '').replace(/\/+$/, '') || cdnBaseValue,

  // 图片处理：原图长边上限、缩略图长边上限、头像边长
  imageMaxDimension: num(env.MAX_IMAGE_DIMENSION, 2560),
  thumbSize: num(env.THUMB_SIZE, 520),
  avatarSize: num(env.AVATAR_SIZE, 256),
  coverMaxDimension: num(env.MAX_COVER_DIMENSION, 1920),

  adminBootstrapUser: (env.ADMIN_BOOTSTRAP_USER || '').trim(),
  adminBootstrapPass: env.ADMIN_BOOTSTRAP_PASS || '',

  // 人机验证（滑块拼图）：进站先过一道验证，通过后一段时间内不再打扰。
  // 网页端和启动器共用同一套接口，启动器用 X-Human-Token 请求头带令牌。
  // 自测 / 接口脚本可以把 HUMAN_CHECK 设成 0 关掉，省得每次都要过验证。
  humanCheck: {
    enabled: bool(env.HUMAN_CHECK, true),
    // 通过后免验多少小时
    ttlHours: Math.max(0.5, num(env.HUMAN_CHECK_TTL_HOURS, 8)),
    // 签名密钥：不配的话每次重启都会换一把，旧令牌随之失效
    secret: env.HUMAN_CHECK_SECRET || '',
  },

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
