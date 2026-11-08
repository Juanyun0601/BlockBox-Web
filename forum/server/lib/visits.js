/**
 * 访问统计
 *
 * - 记录每次页面浏览，按天汇总出浏览量（PV）、访客数（UV）、日活（DAU）和月活（MAU）；
 * - 只记真实用户打开的 HTML 页面：接口请求、图片等静态资源、搜索引擎爬虫都不记；
 * - 不存原始 IP，访客用「IP + 浏览器标识 + 盐」的哈希做指纹；
 * - 明细只保留 VISIT_RETENTION_DAYS 天（默认 400 天，够算月活和同比），
 *   访客的首次 / 最近到访时间和累计次数另外长期保留，用来出累计数据。
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, now } from '../db.js';

const DAY = 86400;
const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时区的 YYYY-MM-DD */
export function dayKey(seconds = now()) {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时区某一天的 0 点（秒） */
function startOfDay(seconds = now()) {
  const d = new Date(seconds * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** 不统计的页面：管理后台（管理员自己刷新会刷高数据）和错误页 */
const SKIP_PATHS = new Set(['/404.html']);

/** 管理后台的统计首页和全部子页面（/admin.html、/admin-announcements.html 等）都不统计 */
function isAdminPage(path) {
  return /^\/admin(?:-[a-z]+)?\.html$/.test(path);
}

/** 常见的爬虫 / 脚本 UA，不算访客 */
const BOT_UA =
  /bot|crawl|spider|slurp|headless|phantom|python-requests|python-urllib|curl\/|wget|scrapy|httpclient|go-http-client|okhttp|facebookexternalhit|bingpreview|yandex|ahrefs|semrush|dotbot|petalbot/i;

/** 页面路径归一化：/ 视作首页，去掉查询串 */
export function normalizeVisitPath(pathname) {
  const clean = String(pathname || '/').split('?')[0].split('#')[0];
  if (!clean || clean === '/') return '/index.html';
  return clean.endsWith('/') ? `${clean}index.html` : clean;
}

/** 这次请求要不要计入访问 */
export function shouldTrackVisit(pathname, userAgent = '') {
  const path = normalizeVisitPath(pathname);
  if (!path.endsWith('.html')) return false;
  if (SKIP_PATHS.has(path) || isAdminPage(path)) return false;
  return !BOT_UA.test(String(userAgent || ''));
}

/** 访问最多的几个页面的中文名 */
const PAGE_LABELS = {
  '/index.html': '首页',
  '/board.html': '板块页',
  '/thread.html': '帖子页',
  '/new.html': '发帖页',
  '/login.html': '登录 / 注册',
  '/search.html': '搜索页',
  '/user.html': '个人主页',
  '/friends.html': '好友与私信',
  '/gallery.html': '我的相册',
  '/notifications.html': '通知中心',
  '/feedback.html': '意见反馈',
  '/quiz.html': '入站答题',
};

/** 访客指纹：同一台设备 + 同一个浏览器算同一个人 */
function visitorKey(ip, userAgent) {
  return crypto
    .createHash('sha256')
    .update(`${config.visitSalt}|${ip}|${userAgent}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * 记一次页面访问。任何异常都只打日志，绝不影响页面本身。
 * @param {{ path: string, ip?: string, userAgent?: string, userId?: number, ref?: string }} visit
 */
export function recordVisit({ path, ip = '', userAgent = '', userId = 0, ref = '' }) {
  if (!config.visitTracking) return;
  try {
    if (!shouldTrackVisit(path, userAgent)) return;

    const pagePath = normalizeVisitPath(path);
    const visitor = visitorKey(ip, userAgent);
    const at = now();

    db.prepare(
      `INSERT INTO visits (day, visitor, user_id, path, ref, ua, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dayKey(at),
      visitor,
      Number(userId) || 0,
      pagePath.slice(0, 120),
      String(ref || '').slice(0, 200),
      String(userAgent || '').slice(0, 200),
      at,
    );

    // 老访客只更新最近到访时间和累计次数；新访客才建档案
    const inserted = db
      .prepare(
        `INSERT INTO visit_visitors (visitor, first_seen_at, last_seen_at, hits)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(visitor) DO NOTHING`,
      )
      .run(visitor, at, at).changes;
    if (!inserted) {
      db.prepare('UPDATE visit_visitors SET last_seen_at = ?, hits = hits + 1 WHERE visitor = ?').run(at, visitor);
    }
  } catch (error) {
    console.error('[论坛] 记录访问失败：', error.message);
  }
}

/**
 * 管理后台的访问数据。
 * @param {{ days?: number }} options days：趋势图回看天数（1–365，默认 30）
 */
export function visitStats({ days = 30 } = {}) {
  const rangeDays = Math.min(365, Math.max(1, Math.floor(Number(days) || 30)));
  const current = now();
  const todayStart = startOfDay(current);
  const tomorrowStart = todayStart + DAY;
  const yesterdayStart = startOfDay(todayStart - DAY);
  const weekStart = startOfDay(todayStart - 6 * DAY);
  const monthStart = startOfDay(todayStart - 29 * DAY);
  const firstRangeDay = dayKey(todayStart - (rangeDays - 1) * DAY);

  const windowStats = (from, to) =>
    db
      .prepare(
        `SELECT COUNT(*) AS pv,
                COUNT(DISTINCT visitor) AS uv,
                COUNT(DISTINCT CASE WHEN user_id > 0 THEN user_id END) AS users
           FROM visits
          WHERE created_at >= ? AND created_at < ?`,
      )
      .get(from, to);

  const today = windowStats(todayStart, tomorrowStart);
  const yesterday = windowStats(yesterdayStart, todayStart);
  const week = windowStats(weekStart, tomorrowStart);
  const month = windowStats(monthStart, tomorrowStart);

  const newToday = db
    .prepare('SELECT COUNT(*) AS n FROM visit_visitors WHERE first_seen_at >= ? AND first_seen_at < ?')
    .get(todayStart, tomorrowStart).n;

  const totals = db
    .prepare('SELECT COUNT(*) AS uv, COALESCE(SUM(hits), 0) AS pv, COALESCE(MAX(last_seen_at), 0) AS last_at FROM visit_visitors')
    .get();

  const online = db.prepare('SELECT COUNT(*) AS n FROM users WHERE last_seen_at > ?').get(current - 900).n;

  const peak = db
    .prepare('SELECT day, COUNT(*) AS pv FROM visits GROUP BY day ORDER BY pv DESC, day DESC LIMIT 1')
    .get();

  const seriesRows = db
    .prepare(
      `SELECT day, COUNT(*) AS pv, COUNT(DISTINCT visitor) AS uv
         FROM visits
        WHERE day >= ?
        GROUP BY day`,
    )
    .all(firstRangeDay);
  const byDay = new Map(seriesRows.map((row) => [row.day, row]));
  const series = [];
  for (let i = rangeDays - 1; i >= 0; i -= 1) {
    const key = dayKey(startOfDay(todayStart - i * DAY));
    const row = byDay.get(key);
    series.push({ day: key, pv: row ? row.pv : 0, uv: row ? row.uv : 0 });
  }

  const hourRows = db
    .prepare(
      `SELECT CAST(strftime('%H', created_at, 'unixepoch', 'localtime') AS INTEGER) AS hour,
              COUNT(*) AS pv, COUNT(DISTINCT visitor) AS uv
         FROM visits
        WHERE created_at >= ? AND created_at < ?
        GROUP BY hour`,
    )
    .all(todayStart, tomorrowStart);
  const byHour = new Map(hourRows.map((row) => [row.hour, row]));
  const hours = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const row = byHour.get(hour);
    hours.push({ hour, pv: row ? row.pv : 0, uv: row ? row.uv : 0 });
  }

  const pages = db
    .prepare(
      `SELECT path, COUNT(*) AS pv, COUNT(DISTINCT visitor) AS uv
         FROM visits
        WHERE day >= ?
        GROUP BY path
        ORDER BY pv DESC, path ASC
        LIMIT 8`,
    )
    .all(firstRangeDay)
    .map((row) => ({ ...row, label: PAGE_LABELS[row.path] || row.path }));

  return {
    range_days: rangeDays,
    retention_days: config.visitRetentionDays,
    summary: {
      today: { pv: today.pv, uv: today.uv, users: today.users, new_visitors: newToday },
      yesterday: { pv: yesterday.pv, uv: yesterday.uv, users: yesterday.users },
      week: { pv: week.pv, uv: week.uv, users: week.users },
      month: { pv: month.pv, uv: month.uv, users: month.users },
      total: { pv: totals.pv, uv: totals.uv, last_seen_at: totals.last_at },
      peak: peak ? { day: peak.day, pv: peak.pv } : null,
      online,
    },
    series,
    hours,
    pages,
  };
}

/** 清理过期明细，启动时和定时任务调用；访客档案不清理 */
export function purgeOldVisits() {
  const keepDays = Math.max(7, Number(config.visitRetentionDays) || 400);
  try {
    const removed = db.prepare('DELETE FROM visits WHERE created_at < ?').run(now() - keepDays * DAY).changes;
    if (removed > 0) console.log(`[论坛] 已清理 ${removed} 条过期访问记录（保留 ${keepDays} 天）`);
  } catch (error) {
    console.error('[论坛] 清理访问记录失败：', error.message);
  }
}
