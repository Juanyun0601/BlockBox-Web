import crypto from 'node:crypto';
import { db, now, transaction } from '../db.js';
import { config } from '../config.js';
import { HttpError } from './http.js';
import { hashPassword } from './auth.js';
import { ensureSupportFriend, supportUserId } from './support.js';
import { ensureOfficialGroupMember } from './official-group.js';

/**
 * 第三方登录（GitHub / LittleSkin OAuth 2.0）。
 *
 * 网页版走标准的授权代码流：浏览器被送去服务商授权，回到 /oauth/callback/<provider>，
 * 服务端拿 code 换 access_token、读用户资料、找到或创建方块盒子账号并种下登录会话。
 *
 * 启动器拿不到浏览器的 Cookie，所以走一套「设备码」：启动器先申请一对码，
 * 打开带 user_code 的授权地址；浏览器授权完成后，启动器用 device_code 轮询取回会话令牌。
 * 这套设备码是本站自己的，和 LittleSkin 的设备代码流无关，不要求服务商支持。
 */

const PROVIDERS = {
  github: { id: 'github', name: 'GitHub' },
  littleskin: { id: 'littleskin', name: 'LittleSkin' },
};

const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USERNAME_MAX = 20;
const DISPLAY_NAME_MAX = 24;

/** 只允许站内相对路径，防止授权完成后被带去站外 */
export function safeNext(target) {
  const value = String(target || '');
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (value.startsWith('/verify.html')) return '/';
  return value;
}

export function providerMeta(provider) {
  const meta = PROVIDERS[String(provider || '').toLowerCase()];
  if (!meta) throw new HttpError(400, '不支持的登录方式', 'unknown_provider');
  return { ...meta, ...config.oauth.providers[meta.id] };
}

export function isProviderEnabled(provider) {
  const meta = providerMeta(provider);
  return !!meta.clientId && !!meta.clientSecret;
}

export function enabledProviders() {
  return Object.values(PROVIDERS)
    .map((item) => ({ ...item, enabled: isProviderEnabled(item.id) }))
    .filter((item) => item.enabled);
}

/** 所有第三方登录方式及其启用状态（登录页据此决定显示哪些按钮） */
export function providerStatus() {
  return Object.values(PROVIDERS).map((item) => ({
    ...item,
    enabled: isProviderEnabled(item.id),
  }));
}

/** 生成回调地址的站点根：优先配置，没有就按这次请求的 Host 现算（方便本机调试） */
export function requestOrigin(req) {
  if (config.oauth.publicBase) return config.oauth.publicBase;
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = (config.trustProxy && forwarded) || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers.host || '127.0.0.1');
  return `${proto}://${host}`;
}

export function callbackUrl(req, provider) {
  return `${requestOrigin(req)}/oauth/callback/${provider}`;
}

export function buildAuthorizeUrl(provider, state, redirectUri) {
  const meta = providerMeta(provider);
  const url = new URL(meta.authorizeUrl);
  url.searchParams.set('client_id', meta.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  if (meta.scope) url.searchParams.set('scope', meta.scope);
  url.searchParams.set('state', state);
  return url.toString();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function makeUserCode() {
  let body = '';
  for (let i = 0; i < 8; i += 1) {
    body += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)];
  }
  return body;
}

// ────────────────────────────────────────────────────────── 授权状态

export function createOAuthState({ provider, redirectUri, nextPath, deviceCode = '', bindUserId = 0 }) {
  const state = randomToken(24);
  const timestamp = now();
  db.prepare(
    `INSERT INTO oauth_states
       (state, provider, redirect_uri, next_path, device_code, bind_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    state,
    provider,
    redirectUri,
    safeNext(nextPath),
    deviceCode,
    Number(bindUserId) || 0,
    timestamp,
    timestamp + config.oauth.stateTtl,
  );
  return state;
}

/** 取出并作废一次性 state；provider 对不上、过期、重复使用都按无效处理 */
export function consumeOAuthState(state, provider) {
  const key = String(state || '');
  if (!key) return null;
  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(key);
  if (row) db.prepare('DELETE FROM oauth_states WHERE state = ?').run(key);
  if (!row) return null;
  if (row.provider !== provider) return null;
  if (Number(row.expires_at) <= now()) return null;
  return row;
}

// ────────────────────────────────────────────────────────── 启动器设备码

export function createDevice(provider, base = '') {
  const meta = providerMeta(provider);
  const timestamp = now();
  let userCode = makeUserCode();
  for (let i = 0; i < 20; i += 1) {
    const used = db.prepare('SELECT 1 FROM oauth_devices WHERE user_code = ?').get(userCode);
    if (!used) break;
    userCode = makeUserCode();
  }

  const deviceCode = randomToken(32);
  const expiresAt = timestamp + config.oauth.deviceTtl;
  db.prepare(
    `INSERT INTO oauth_devices
       (device_code, user_code, provider, status, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(deviceCode, userCode, meta.id, timestamp, expiresAt);

  const root = String(base || config.oauth.publicBase || '').replace(/\/+$/, '');
  const verificationUrl = root
    ? `${root}/oauth/start/${meta.id}?device=${encodeURIComponent(userCode)}`
    : `/oauth/start/${meta.id}?device=${encodeURIComponent(userCode)}`;

  return {
    provider: meta.id,
    device_code: deviceCode,
    user_code: userCode,
    verification_url: verificationUrl,
    expires_in: config.oauth.deviceTtl,
    interval: config.oauth.deviceInterval,
  };
}

export function deviceByUserCode(userCode, provider) {
  const code = String(userCode || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!code) return null;
  const row = db
    .prepare('SELECT * FROM oauth_devices WHERE user_code = ? AND provider = ?')
    .get(code, provider);
  if (!row) return null;
  if (Number(row.expires_at) <= now()) {
    if (row.status === 'pending') {
      db.prepare("UPDATE oauth_devices SET status = 'expired' WHERE device_code = ?").run(row.device_code);
    }
    return null;
  }
  return row;
}

export function deviceStatus(deviceCode) {
  const row = db.prepare('SELECT * FROM oauth_devices WHERE device_code = ?').get(String(deviceCode || ''));
  if (!row) return null;
  if (row.status === 'pending' && Number(row.expires_at) <= now()) {
    db.prepare("UPDATE oauth_devices SET status = 'expired' WHERE device_code = ?").run(row.device_code);
    row.status = 'expired';
  }
  return row;
}

export function authorizeDevice(deviceCode, userId, sessionToken) {
  const result = db
    .prepare(
      `UPDATE oauth_devices
          SET status = 'authorized', user_id = ?, session_token = ?, message = ''
        WHERE device_code = ? AND status = 'pending' AND expires_at > ?`,
    )
    .run(Number(userId) || 0, String(sessionToken || ''), String(deviceCode || ''), now());
  return Number(result.changes) > 0;
}

export function failDevice(deviceCode, message) {
  if (!deviceCode) return;
  db.prepare(
    `UPDATE oauth_devices
        SET status = 'failed', message = ?
      WHERE device_code = ? AND status = 'pending'`,
  ).run(String(message || '登录失败').slice(0, 300), String(deviceCode));
}

// ────────────────────────────────────────────────────────── 服务商 HTTP

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'follow' });
  } catch (error) {
    throw new HttpError(502, '连不上第三方登录服务，请检查网络后再试', 'oauth_unreachable');
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = data?.error_description || data?.error || data?.message || '';
    throw new HttpError(
      502,
      detail ? `第三方登录服务返回错误：${detail}` : '第三方登录服务暂时不可用，请稍后再试',
      'oauth_provider_error',
    );
  }
  if (!data || typeof data !== 'object') {
    throw new HttpError(502, '第三方登录服务返回的数据无法解析', 'oauth_bad_response');
  }
  return data;
}

export async function exchangeCode(provider, code, redirectUri) {
  const meta = providerMeta(provider);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: meta.clientId,
    client_secret: meta.clientSecret,
    redirect_uri: redirectUri,
    code: String(code || ''),
  });

  let response;
  try {
    response = await fetch(meta.tokenUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HttpError(502, '连不上第三方登录服务，请检查网络后再试', 'oauth_unreachable');
  }

  const text = await response.text();
  let data = null;
  const type = String(response.headers.get('content-type') || '');
  if (type.includes('json')) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  } else {
    // GitHub 在个别代理 / 网关下会退回表单编码，兼容一下
    const params = new URLSearchParams(text);
    if (params.has('access_token') || params.has('error')) data = Object.fromEntries(params);
  }

  if (!response.ok || !data || data.error) {
    const detail = data?.error_description || data?.error || '';
    throw new HttpError(
      502,
      detail ? `第三方登录失败：${detail}` : '第三方登录服务暂时不可用，请稍后再试',
      'oauth_provider_error',
    );
  }
  const token = String(data.access_token || '');
  if (!token) throw new HttpError(502, '第三方登录没有返回访问令牌', 'oauth_bad_token');
  return token;
}

function githubHeaders(accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'BlockBox-Forum',
    'x-github-api-version': '2022-11-28',
  };
}

async function fetchGithubProfile(accessToken) {
  const meta = providerMeta('github');
  const user = await fetchJson(meta.userUrl, { headers: githubHeaders(accessToken) });

  let email = String(user.email || '');
  let emailVerified = false;
  if (meta.emailsUrl) {
    try {
      const emails = await fetchJson(meta.emailsUrl, { headers: githubHeaders(accessToken) });
      if (Array.isArray(emails)) {
        const verified = emails.filter((item) => item && item.verified && item.email);
        const primary = verified.find((item) => item.primary) || verified[0];
        if (primary) {
          email = String(primary.email);
          emailVerified = true;
        }
      }
    } catch {
      // 用户没授权邮箱权限时读不到列表：保留公开邮箱，但按未验证处理
    }
  }

  return {
    provider: 'github',
    uid: String(user.id || ''),
    usernameHint: String(user.login || '').trim(),
    displayName: String(user.name || user.login || '').trim(),
    email,
    emailVerified,
    avatar: String(user.avatar_url || ''),
  };
}

async function fetchLittleskinProfile(accessToken) {
  const meta = providerMeta('littleskin');
  const user = await fetchJson(meta.userUrl, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (user.code && Number(user.code) !== 0) {
    throw new HttpError(502, String(user.message || 'LittleSkin 拒绝了这次请求'), 'oauth_provider_error');
  }
  if (Number(user.permission) === -1) {
    throw new HttpError(403, '这个 LittleSkin 账号已被封禁，无法登录', 'oauth_banned');
  }
  const uid = String(user.uid || '');
  if (!uid) throw new HttpError(502, 'LittleSkin 没有返回账号标识', 'oauth_bad_response');
  const verified =
    user.verified === true || user.verified === 1 || user.verified === 'true' || user.verified === '1';
  return {
    provider: 'littleskin',
    uid,
    usernameHint: String(user.nickname || user.username || '').trim(),
    displayName: String(user.nickname || user.username || '').trim(),
    email: String(user.email || ''),
    emailVerified: verified,
    avatar: /^https?:\/\//i.test(String(user.avatar || '')) ? String(user.avatar) : '',
  };
}

export function fetchProfile(provider, accessToken) {
  if (provider === 'github') return fetchGithubProfile(accessToken);
  if (provider === 'littleskin') return fetchLittleskinProfile(accessToken);
  throw new HttpError(400, '不支持的登录方式', 'unknown_provider');
}

// ────────────────────────────────────────────────────────── 账号查找 / 创建

const providerLabel = (provider) => PROVIDERS[provider]?.name || provider;

function findUserByLink(provider, uid) {
  return db
    .prepare(
      `SELECT u.* FROM oauth_links l JOIN users u ON u.id = l.user_id
        WHERE l.provider = ? AND l.provider_uid = ?`,
    )
    .get(provider, uid);
}

function findUserByVerifiedEmail(email) {
  if (!email) return null;
  // 站内邮箱不做唯一约束：只有一个已验证账号时才允许自动合并，多个同名邮箱宁可新建
  const rows = db
    .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND email_verified_at > 0')
    .all(email);
  return rows.length === 1 ? rows[0] : null;
}

function findUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id) || 0);
}

function linkRow(provider, uid) {
  return db
    .prepare('SELECT * FROM oauth_links WHERE provider = ? AND provider_uid = ?')
    .get(provider, uid);
}

function insertLink(userId, profile) {
  try {
    db.prepare(
      `INSERT INTO oauth_links
         (user_id, provider, provider_uid, display_name, avatar, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      profile.provider,
      profile.uid,
      String(profile.displayName || '').slice(0, 60),
      String(profile.avatar || '').slice(0, 500),
      now(),
      now(),
    );
  } catch (error) {
    // 并发绑定同一个第三方账号时，唯一索引会拦下来：给用户一句能看懂的解释
    if (String(error?.message || '').includes('UNIQUE')) {
      throw new HttpError(
        409,
        `这个${providerLabel(profile.provider)}账号已经绑定了另一个方块盒子账号`,
        'oauth_already_linked',
      );
    }
    throw error;
  }
}

function touchLink(linkId) {
  db.prepare('UPDATE oauth_links SET last_login_at = ? WHERE id = ?').run(now(), linkId);
}

/** 把服务商昵称收拾成合法的论坛用户名（中文 / 字母 / 数字 / 下划线 / 短横线，2–20 位） */
function sanitizeUsername(hint, provider) {
  let base = String(hint || '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]/g, '')
    .slice(0, USERNAME_MAX);
  if ([...base].length < 2) base = `${provider}_user`.slice(0, USERNAME_MAX);
  if (/^\d+$/.test(base)) base = `${base}_${provider}`.slice(0, USERNAME_MAX);
  return base;
}

function uniqueUsername(hint, provider) {
  const base = sanitizeUsername(hint, provider);
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE');
  for (let index = 1; index <= 99; index += 1) {
    const suffix = index === 1 ? '' : `_${index}`;
    const name = `${base.slice(0, USERNAME_MAX - suffix.length)}${suffix}`;
    if (!exists.get(name)) return name;
  }
  return `user_${crypto.randomBytes(4).toString('hex')}`;
}

function createUserFromProfile(profile) {
  const firstUser = db.prepare('SELECT COUNT(*) AS n FROM users WHERE id != ?').get(supportUserId()).n === 0;
  if (!config.registerOpen && !firstUser) {
    throw new HttpError(
      403,
      `本站暂时关闭注册，请先登录已有方块盒子账号，再在个人设置里绑定${providerLabel(profile.provider)}`,
      'register_closed',
    );
  }

  const username = uniqueUsername(profile.usernameHint || profile.displayName, profile.provider);
  const displayName = String(profile.displayName || username).slice(0, DISPLAY_NAME_MAX);
  const rawEmail = String(profile.email || '').slice(0, 120);
  // 站内邮箱不做唯一约束，但注册 / 改资料都按「一个邮箱一个账号」处理。
  // 第三方资料里的邮箱如果已经被别的账号用了（且没走到上面的自动合并），这里就不再重复存。
  const emailTaken =
    rawEmail &&
    !!db
      .prepare("SELECT 1 FROM users WHERE email <> '' AND email = ? COLLATE NOCASE")
      .get(rawEmail);
  const email = emailTaken ? '' : rawEmail;
  const emailVerifiedAt = email && profile.emailVerified ? now() : 0;
  const timestamp = now();

  return transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO users
           (username, display_name, pass_hash, email, email_verified_at, password_set,
            role, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        username,
        displayName,
        hashPassword(crypto.randomBytes(24).toString('hex')),
        email,
        emailVerifiedAt,
        firstUser ? 'admin' : 'user',
        timestamp,
        timestamp,
      );
    const userId = Number(result.lastInsertRowid);
    insertLink(userId, profile);
    ensureSupportFriend(userId);
    ensureOfficialGroupMember(userId);
    return findUserById(userId);
  });
}

/**
 * 找到这次第三方登录对应的方块盒子账号。
 *
 * 优先级：
 *   1. 这个第三方账号已经绑定过：直接登录那个账号；
 *   2. 发起时浏览器已登录 / 明确点了「绑定」：绑到当前账号；
 *   3. 服务商返回的是已验证邮箱，且站内已经有同邮箱的已验证账号：自动绑过去；
 *   4. 以上都没有：自动创建一个新账号（注册关闭时给出明确提示）。
 */
export function resolveOAuthUser({ provider, profile, bindUserId = 0, browserUserId = 0 }) {
  const existingUser = findUserByLink(provider, profile.uid);
  if (existingUser) {
    const link = linkRow(provider, profile.uid);
    if (bindUserId && Number(bindUserId) !== Number(existingUser.id)) {
      throw new HttpError(
        409,
        `这个${providerLabel(provider)}账号已经绑定了另一个方块盒子账号`,
        'oauth_already_linked',
      );
    }
    if (existingUser.status === 'banned') {
      throw new HttpError(403, '这个方块盒子账号已被封禁，无法登录', 'banned');
    }
    if (link) touchLink(link.id);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), existingUser.id);
    return { user: findUserById(existingUser.id), created: false, linked: false };
  }

  const targetId = Number(bindUserId) || Number(browserUserId) || 0;
  if (targetId) {
    const user = findUserById(targetId);
    if (!user) throw new HttpError(401, '登录状态已失效，请重新登录后再试', 'unauthorized');
    if (user.status === 'banned') throw new HttpError(403, '这个方块盒子账号已被封禁，无法登录', 'banned');
    // 并发下同一个第三方账号可能刚被別处绑走：再查一次，避免把别人的绑定覆盖掉
    if (linkRow(provider, profile.uid)) {
      throw new HttpError(
        409,
        `这个${providerLabel(provider)}账号已经绑定了另一个方块盒子账号`,
        'oauth_already_linked',
      );
    }
    insertLink(user.id, profile);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), user.id);
    return { user, created: false, linked: true };
  }

  const mailUser = findUserByVerifiedEmail(profile.email);
  if (mailUser && profile.emailVerified) {
    insertLink(mailUser.id, profile);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), mailUser.id);
    return { user: mailUser, created: false, linked: true };
  }

  const user = createUserFromProfile(profile);
  return { user, created: true, linked: true };
}

// ────────────────────────────────────────────────────────── 绑定管理

export function listOAuthLinks(userId) {
  return db
    .prepare(
      `SELECT provider, provider_uid, display_name, avatar, created_at, last_login_at
         FROM oauth_links WHERE user_id = ? ORDER BY created_at ASC`,
    )
    .all(Number(userId) || 0)
    .map((row) => ({
      provider: row.provider,
      name: providerLabel(row.provider),
      uid: row.provider_uid,
      display_name: row.display_name || '',
      avatar: row.avatar || '',
      created_at: row.created_at,
      last_login_at: row.last_login_at || 0,
    }));
}

export function unlinkOAuthProvider(userId, provider) {
  const meta = providerMeta(provider);
  const user = findUserById(userId);
  if (!user) throw new HttpError(401, '请先登录', 'unauthorized');

  const links = listOAuthLinks(user.id);
  const target = links.find((item) => item.provider === meta.id);
  if (!target) throw new HttpError(404, `还没有绑定${meta.name}`, 'oauth_not_linked');

  if (user.password_set === 0 && links.length <= 1) {
    throw new HttpError(
      400,
      `这是这个账号唯一的登录方式，请先在「账号设置」里设置密码，再解除${meta.name}绑定`,
      'last_login_method',
    );
  }

  db.prepare('DELETE FROM oauth_links WHERE user_id = ? AND provider = ?').run(user.id, meta.id);
  return listOAuthLinks(user.id);
}
