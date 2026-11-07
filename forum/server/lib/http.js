import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** 业务错误：抛出后由调度器统一转成 JSON 响应 */
export class HttpError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message, code = 'bad_request') => new HttpError(400, message, code);
export const unauthorized = (message = '请先登录', code = 'unauthorized') => new HttpError(401, message, code);
export const forbidden = (message = '没有权限', code = 'forbidden') => new HttpError(403, message, code);
export const notFound = (message = '内容不存在', code = 'not_found') => new HttpError(404, message, code);

export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
}

/** 解析 Cookie 头 */
export function parseCookies(header) {
  const jar = Object.create(null);
  if (!header) return jar;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      jar[name] = value;
    }
  }
  return jar;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 读取原始请求体，超过上限直接中断 */
export function readRawBody(req, limit = config.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (error) => {
      if (done) return;
      done = true;
      req.destroy();
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, `内容太大（上限 ${Math.round(limit / 1024)} KB）`, 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

export async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest('请求内容必须是 JSON 对象');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw badRequest('请求内容不是合法的 JSON');
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 托管静态文件：root 为绝对目录，urlPath 为以 / 开头的路径。
 * 目录请求回退到 index.html，找不到返回 false 交给上层处理。
 * rewrite：对 HTML 做一次内存改写（走 CDN 时用）；
 * publicResource：公开资源，放开跨域并允许 CDN / 浏览器长期缓存。
 */
export async function serveFile(res, root, urlPath, { immutable = false, rewrite = null, publicResource = false } = {}) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  let relative = clean.replace(/^\/+/, '');
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';

  const target = path.resolve(root, relative);
  const rootWithSep = path.resolve(root) + path.sep;
  if (target !== path.resolve(root) && !target.startsWith(rootWithSep)) return false;

  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch {
    return false;
  }
  if (stat.isDirectory()) {
    const index = path.join(target, 'index.html');
    try {
      stat = await fs.promises.stat(index);
    } catch {
      return false;
    }
    return serveFile(res, root, `/index.html`, { immutable });
  }

  const type = MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=2592000, immutable' : 'no-cache',
  };
  // 图片 / 脚本可能被 CDN 回源、也可能被别的页面直接引用，放开跨域读取
  if (publicResource) headers['access-control-allow-origin'] = '*';

  // 页面 HTML 要在内存里改写资源地址，这类文件很小，直接读成字符串再发
  if (rewrite && type.startsWith('text/html')) {
    const body = rewrite(await fs.promises.readFile(target, 'utf8'));
    res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return true;
  }

  res.writeHead(200, {
    ...headers,
    'content-length': stat.size,
    'last-modified': stat.mtime.toUTCString(),
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

export function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.length > 0) return real.trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** 是否为安全方法 */
export const isSafeMethod = (method) => method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

/**
 * 跨站请求检查：浏览器带 Origin 时，必须与本站或白名单一致。
 * 命令行 / 启动器这类不带 Origin 的调用放行（它们本来就不共享 Cookie）。
 */
export function checkOrigin(headers) {
  const origin = headers.origin;
  if (!origin) return true;
  const normalized = String(origin).replace(/\/+$/, '');
  if (config.allowedOrigins.includes(normalized)) return true;
  if (config.publicOrigin && normalized === config.publicOrigin) return true;
  const host = headers.host;
  if (host) {
    try {
      const originHost = new URL(normalized).host;
      if (originHost === host) return true;
    } catch {
      return false;
    }
  }
  return false;
}
