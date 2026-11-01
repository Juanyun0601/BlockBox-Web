import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { config, ROOT_DIR } from './config.js';
import { db, purgeExpiredSessions, now } from './db.js';
import { purgeExpiredEmailCodes } from './lib/email-code.js';
import {
  HttpError,
  applySecurityHeaders,
  checkOrigin,
  clientIp,
  isSafeMethod,
  notFound,
  parseCookies,
  readJsonBody,
  sendJson,
  serveFile,
} from './lib/http.js';
import { SESSION_COOKIE, hashPassword, userFromToken } from './lib/auth.js';
import { purgeOldVisits, recordVisit } from './lib/visits.js';
import registerAuth from './routes/auth.js';
import registerBoards from './routes/boards-threads.js';
import registerUsers from './routes/users.js';
import registerSearch from './routes/search.js';
import registerAdmin from './routes/admin.js';
import registerCommunity from './routes/community.js';
import registerFriends from './routes/friends.js';
import registerFeedback from './routes/feedback.js';
import registerQuiz from './routes/quiz.js';
import registerLobby from './routes/lobby.js';

const VERSION = '0.1.0';

// ---------------------------------------------------------------- 路由表

function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    const keys = [];
    const source = pattern.replace(/\/:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    });
    routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
  };

  const router = {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    patch: (pattern, handler) => add('PATCH', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const found = route.regex.exec(pathname);
        if (!found) continue;
        const params = Object.create(null);
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(found[index + 1]);
        });
        return { handler: route.handler, params };
      }
      return null;
    },
  };
  return router;
}

const router = createRouter();
for (const register of [registerAuth, registerBoards, registerUsers, registerSearch, registerAdmin, registerCommunity, registerFriends, registerFeedback, registerQuiz, registerLobby]) {
  register(router);
}

// ---------------------------------------------------------------- 工具

/** 首次启动且配置了引导管理员时创建它 */
function bootstrapAdmin() {
  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (admins > 0) return;
  const { adminBootstrapUser: name, adminBootstrapPass: pass } = config;
  if (!name || !pass) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (total === 0) {
      console.log('[论坛] 还没有任何用户：第一个注册的账号会自动成为管理员。');
    }
    return;
  }
  const timestamp = now();
  db.prepare(
    `INSERT INTO users (username, display_name, pass_hash, role, created_at, last_seen_at)
     VALUES (?, ?, ?, 'admin', ?, ?)`,
  ).run(name, name, hashPassword(pass), timestamp, timestamp);
  console.log(`[论坛] 已创建引导管理员：${name}`);
}

function logRequest(req, res, startedAt) {
  if (!config.logRequests) return;
  const ms = Date.now() - startedAt;
  const status = res.statusCode;
  console.log(`${status} ${req.method} ${req.url} ${ms}ms`);
}

function resolveCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const normalized = String(origin).replace(/\/+$/, '');
  const allowed =
    config.allowedOrigins.includes(normalized) ||
    (config.publicOrigin && normalized === config.publicOrigin) ||
    normalized.endsWith(`//${req.headers.host}`);
  if (!allowed) return;
  res.setHeader('access-control-allow-origin', normalized);
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

// ---------------------------------------------------------------- 主处理

async function handle(req, res) {
  const startedAt = Date.now();
  res.on('finish', () => logRequest(req, res, startedAt));

  applySecurityHeaders(res);
  resolveCors(req, res);

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const ip = clientIp(req);
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE] || '';
  const user = userFromToken(token);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'blockbox-forum', version: VERSION, time: now() });
    return;
  }

  if (pathname.startsWith('/api/')) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const matched = router.match(method, pathname);
    if (!matched) throw notFound('接口不存在');

    if (!isSafeMethod(method) && !checkOrigin(req.headers)) {
      throw new HttpError(403, '请求来源不被允许', 'bad_origin');
    }

    let cachedBody;
    const ctx = {
      req,
      res,
      url,
      params: matched.params,
      user,
      token,
      ip,
      userAgent: String(req.headers['user-agent'] || ''),
      async json() {
        if (cachedBody !== undefined) return cachedBody;
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type && type !== 'application/json') {
          throw new HttpError(415, '请求内容必须是 application/json', 'unsupported_media_type');
        }
        cachedBody = await readJsonBody(req);
        return cachedBody;
      },
    };

    const payload = await matched.handler(ctx);
    if (res.writableEnded) return;
    sendJson(res, 200, payload ?? { ok: true });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') throw notFound('页面不存在');

  if (pathname.startsWith('/uploads/')) {
    const relative = pathname.slice('/uploads'.length);
    if (await serveFile(res, config.uploadDir, relative, { immutable: true })) return;
    // 缩略图缺失时（比如老图或没装 sharp 的 JPEG）退回原图，不报 404
    if (pathname.startsWith('/uploads/thumbs/')) {
      const original = `/${path.basename(pathname)}`;
      if (await serveFile(res, config.uploadDir, original, { immutable: true })) return;
    }
    throw notFound('文件不存在');
  }

  const immutable = pathname.startsWith('/assets/');
  if (await serveFile(res, config.webDir, pathname, { immutable })) {
    // 只有正常打开的页面才计入访问量（静态资源、404 都不算）
    if (!immutable) {
      recordVisit({
        path: pathname,
        ip,
        userAgent: String(req.headers['user-agent'] || ''),
        userId: user ? user.id : 0,
        ref: String(req.headers.referer || ''),
      });
    }
    return;
  }

  // 页面找不到：给一个 404 页面，而不是纯文本
  const notFoundPage = path.join(config.webDir, '404.html');
  if (fs.existsSync(notFoundPage)) {
    const html = await fs.promises.readFile(notFoundPage, 'utf8');
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  throw notFound('页面不存在');
}

// ---------------------------------------------------------------- 启动

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.writableEnded) return;
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message, code: error.code });
        return;
      }
      console.error('[论坛] 未处理的错误：', error);
      sendJson(res, 500, { error: '服务器开小差了，请稍后再试', code: 'internal_error' });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT_DIR, 'server', 'index.js');

if (isMain) {
  bootstrapAdmin();
  purgeExpiredSessions();
  purgeOldVisits();
  purgeExpiredEmailCodes();

  const server = createServer();
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[论坛] 端口 ${config.port} 已被占用：可能已经开着一个了，或换个 PORT 再试。`);
    } else if (error.code === 'EACCES') {
      console.error(`[论坛] 没有权限监听 ${config.port} 端口（1024 以下需要管理员权限）。`);
    } else {
      console.error('[论坛] 启动失败：', error);
    }
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
    console.log(`[论坛] 已启动：http://${shown}:${config.port}`);
    console.log(`[论坛] 数据库：${config.dbPath}`);
    console.log(`[论坛] 页面目录：${config.webDir}`);
  });

  const timer = setInterval(() => {
    purgeExpiredSessions();
    purgeOldVisits();
    purgeExpiredEmailCodes();
  }, 6 * 60 * 60 * 1000);
  timer.unref();

  const shutdown = (signal) => {
    console.log(`[论坛] 收到 ${signal}，正在退出…`);
    server.close(() => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
