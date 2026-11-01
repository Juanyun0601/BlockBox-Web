import { db, now } from '../db.js';
import { config } from '../config.js';
import { badRequest, readRawBody } from '../lib/http.js';
import { enforce } from '../lib/rate-limit.js';
import { removeUpload, saveImage } from '../lib/images.js';
import { unreadNotifications } from '../lib/notify.js';
import { socialUnread } from '../lib/social.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  publicUser,
  requireUser,
  sessionCookie,
  verifyPassword,
} from '../lib/auth.js';
import { email as emailField, password as passwordField, text, username as usernameField } from '../lib/validate.js';

const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

function findByUsername(name) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(name);
}

export default function register(router) {
  router.post('/api/auth/register', async (ctx) => {
    enforce(`register:${ctx.ip}`, 6, 60 * 60 * 1000, '注册太频繁');

    const firstUser = userCount() === 0;
    if (!config.registerOpen && !firstUser) {
      throw badRequest('本站暂时关闭注册，请联系管理员开通账号', 'register_closed');
    }

    const body = await ctx.json();
    const name = usernameField(body.username);
    const pass = passwordField(body.password);
    if (findByUsername(name)) throw badRequest('这个用户名已经被注册了', 'username_taken');

    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO users (username, display_name, pass_hash, email, role, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        '',
        hashPassword(pass),
        emailField(body.email),
        firstUser ? 'admin' : 'user',
        timestamp,
        timestamp,
      );

    const userId = Number(result.lastInsertRowid);
    const { token, expiresAt } = createSession(userId, { ip: ctx.ip, ua: ctx.userAgent });
    sessionCookie(ctx.res, token, expiresAt);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return { user: publicUser(user, { self: true }), first_user: firstUser };
  });

  router.post('/api/auth/login', async (ctx) => {
    enforce(`login-ip:${ctx.ip}`, 30, 15 * 60 * 1000, '登录尝试太频繁');
    const body = await ctx.json();
    const name = text(body.username, { field: '用户名', min: 1, max: 40 });
    enforce(`login-user:${name.toLowerCase()}`, 10, 15 * 60 * 1000, '该账号尝试太频繁');

    const row = findByUsername(name);
    if (!row || !verifyPassword(String(body.password || ''), row.pass_hash)) {
      throw badRequest('用户名或密码不正确', 'bad_credentials');
    }
    if (row.status === 'banned') throw badRequest('该账号已被封禁，如有疑问请联系管理员', 'banned');

    const { token, expiresAt } = createSession(row.id, { ip: ctx.ip, ua: ctx.userAgent });
    sessionCookie(ctx.res, token, expiresAt);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), row.id);
    return { user: publicUser(row, { self: true }) };
  });

  router.post('/api/auth/logout', async (ctx) => {
    destroySession(ctx.token);
    clearSessionCookie(ctx.res);
    return { ok: true };
  });

  router.get('/api/me', async (ctx) => ({
    user: publicUser(ctx.user, { self: true }),
    unread: unreadNotifications(ctx.user?.id),
    friend_unread: socialUnread(ctx.user?.id),
    site: {
      name: config.siteName,
      desc: config.siteDesc,
      register_open: config.registerOpen || userCount() === 0,
    },
  }));

  router.patch('/api/me', async (ctx) => {
    const user = requireUser(ctx.user);
    const body = await ctx.json();
    const displayName = text(body.display_name, { field: '昵称', max: 24, optional: true });
    const bio = text(body.bio, { field: '个人简介', max: 300, optional: true });
    const mail = emailField(body.email);
    db.prepare('UPDATE users SET display_name = ?, bio = ?, email = ? WHERE id = ?').run(
      displayName,
      bio,
      mail,
      user.id,
    );
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), { self: true }) };
  });

  router.post('/api/me/password', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`password:${user.id}`, 5, 60 * 60 * 1000, '改密码太频繁');
    const body = await ctx.json();
    const current = String(body.current_password || '');
    const next = passwordField(body.new_password);
    const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(current, row.pass_hash)) throw badRequest('当前密码不正确', 'bad_password');
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
    // 改完密码把其他设备踢下线
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, ctx.token || '');
    return { ok: true };
  });

  router.post('/api/me/avatar', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`avatar:${user.id}`, 10, 60 * 60 * 1000, '换头像太频繁');

    const raw = await readRawBody(ctx.req, config.maxAvatarBytes);
    const saved = await saveImage(raw, {
      userId: user.id,
      kind: 'avatar',
      maxBytes: config.maxAvatarBytes,
    });

    const old = db.prepare('SELECT avatar FROM users WHERE id = ?').get(user.id)?.avatar || '';
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(saved.url, user.id);
    removeUpload(old);

    return { avatar: saved.url };
  });

  router.delete('/api/me/avatar', async (ctx) => {
    const user = requireUser(ctx.user);
    const old = db.prepare('SELECT avatar FROM users WHERE id = ?').get(user.id)?.avatar || '';
    db.prepare("UPDATE users SET avatar = '' WHERE id = ?").run(user.id);
    removeUpload(old);
    return { ok: true };
  });

  // 个人主页封面：与头像同一套流程，只是尺寸上限更宽、不生成缩略图
  router.post('/api/me/cover', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`cover:${user.id}`, 10, 60 * 60 * 1000, '换封面太频繁');

    const raw = await readRawBody(ctx.req, config.maxCoverBytes);
    const saved = await saveImage(raw, {
      userId: user.id,
      kind: 'cover',
      maxBytes: config.maxCoverBytes,
    });

    const old = db.prepare('SELECT cover FROM users WHERE id = ?').get(user.id)?.cover || '';
    db.prepare('UPDATE users SET cover = ? WHERE id = ?').run(saved.url, user.id);
    removeUpload(old);

    return { cover: saved.url };
  });

  router.delete('/api/me/cover', async (ctx) => {
    const user = requireUser(ctx.user);
    const old = db.prepare('SELECT cover FROM users WHERE id = ?').get(user.id)?.cover || '';
    db.prepare("UPDATE users SET cover = '' WHERE id = ?").run(user.id);
    removeUpload(old);
    return { ok: true };
  });
}
