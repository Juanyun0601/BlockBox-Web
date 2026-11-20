import { db, now } from '../db.js';
import { config } from '../config.js';
import { badRequest, readRawBody } from '../lib/http.js';
import { enforce } from '../lib/rate-limit.js';
import { EMAIL_CODE_TTL, consumeEmailCode, issueEmailCode } from '../lib/email-code.js';
import { sendMail } from '../lib/mail.js';
import { removeUpload, saveImage } from '../lib/images.js';
import { unreadNotifications } from '../lib/notify.js';
import { socialUnread } from '../lib/social.js';
import { ensureSupportFriend, supportUserId } from '../lib/support.js';
import { ensureOfficialGroupMember } from '../lib/official-group.js';
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

// 官方客服账号不算“第一位用户”，它不应该影响首用户自动成为管理员的规则
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users WHERE id != ?').get(supportUserId()).n;

function findByUsername(name) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(name);
}

/** 一个邮箱只能绑一个账号：注册、改资料、验证邮箱前都先查一遍 */
function emailTakenBy(mail, exceptUserId = 0) {
  if (!mail) return false;
  return !!db
    .prepare("SELECT id FROM users WHERE email <> '' AND email = ? COLLATE NOCASE AND id <> ?")
    .get(mail, exceptUserId);
}

export default function register(router) {
  // 注册卡显示之前先问一句：这站注册要不要填邮箱 + 验证码、现在开不开放。
  // 不涉及任何数据，所以和第三方登录列表一样不被人机验证拦住
  router.get('/api/auth/register/policy', async () => ({
    email_required: config.registerEmailRequired,
    register_open: config.registerOpen || userCount() === 0,
  }));

  // 注册前先给邮箱发验证码：这时用户还没登录，所以单独开一个不要求登录的发码口。
  // 只发码、不建号；验证码校验放在下面的注册接口里，过了才算注册成功
  router.post('/api/auth/register/code', async (ctx) => {
    enforce(`register-code-ip:${ctx.ip}`, 10, 60 * 60 * 1000, '发送太频繁');

    const body = await ctx.json();
    const mail = emailField(body.email);
    if (!mail) throw badRequest('请先填写邮箱地址', 'email_required');
    enforce(`register-code-mail:${mail.toLowerCase()}`, 3, 60 * 60 * 1000, '这个邮箱收验证码太频繁，过一会儿再试');
    if (emailTakenBy(mail)) throw badRequest('这个邮箱已经被注册过了', 'email_taken');

    const { code, expiresIn } = issueEmailCode(mail);
    await sendMail({
      to: mail,
      subject: `【${config.siteName}】注册验证码`,
      text:
        `你正在${config.siteName}注册账号，验证码用于确认这个邮箱是你的。\n\n` +
        `验证码：${code}\n\n` +
        `${Math.round(EMAIL_CODE_TTL / 60)} 分钟内有效，填进注册页就能完成注册。\n` +
        `如果不是你本人的操作，请忽略这封邮件。`,
    });
    return { ok: true, expires_in: expiresIn };
  });

  router.post('/api/auth/register', async (ctx) => {
    enforce(`register:${ctx.ip}`, 6, 60 * 60 * 1000, '注册太频繁');

    const firstUser = userCount() === 0;
    if (!config.registerOpen && !firstUser) {
      throw badRequest('本站暂时关闭注册，请联系管理员开通账号', 'register_closed');
    }

    const body = await ctx.json();
    const name = usernameField(body.username);
    const pass = passwordField(body.password);
    const mail = emailField(body.email);
    // 默认注册就得填邮箱并把验证码验证通过；两条都过了才建号
    if (config.registerEmailRequired && !mail) throw badRequest('请填写邮箱地址', 'email_required');
    if (findByUsername(name)) throw badRequest('这个用户名已经被注册了', 'username_taken');
    if (emailTakenBy(mail)) throw badRequest('这个邮箱已经被注册过了', 'email_taken');

    let emailVerifiedAt = 0;
    if (config.registerEmailRequired) {
      const code = String(body.code || '').trim();
      if (!code) throw badRequest('请填写邮箱验证码', 'email_code_required');
      const checked = consumeEmailCode(mail, code);
      if (!checked.ok) throw badRequest(checked.message, 'email_code_invalid');
      emailVerifiedAt = now();
    }

    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO users (username, display_name, pass_hash, email, email_verified_at, role,
                            created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        '',
        hashPassword(pass),
        mail,
        emailVerifiedAt,
        firstUser ? 'admin' : 'user',
        timestamp,
        timestamp,
      );

    const userId = Number(result.lastInsertRowid);
    // 新玩家默认就有一位好友：官方客服；同时默认进官方全用户群
    ensureSupportFriend(userId);
    ensureOfficialGroupMember(userId);
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
      // 注册要不要填邮箱 + 验证码：前端据此决定显示 / 隐藏邮箱那几栏
      register_email_required: config.registerEmailRequired,
    },
  }));

  router.patch('/api/me', async (ctx) => {
    const user = requireUser(ctx.user);
    const body = await ctx.json();
    const displayName = text(body.display_name, { field: '昵称', max: 24, optional: true });
    const bio = text(body.bio, { field: '个人简介', max: 300, optional: true });
    const mail = emailField(body.email);
    // 换了邮箱就视为未验证；邮箱没变（或都是空）时保留验证记录
    const current = db.prepare('SELECT email, email_verified_at FROM users WHERE id = ?').get(user.id);
    const changed = String(current?.email || '').toLowerCase() !== mail.toLowerCase();
    // 只有真换了邮箱才查重：老账号之间可能存在同一个邮箱，不该因此存不了资料
    if (changed && emailTakenBy(mail, user.id)) {
      throw badRequest('这个邮箱已经被别的账号用过了', 'email_taken');
    }
    const keepVerified =
      !!current?.email_verified_at && !!current.email && current.email.toLowerCase() === mail.toLowerCase();
    db.prepare('UPDATE users SET display_name = ?, bio = ?, email = ?, email_verified_at = ? WHERE id = ?').run(
      displayName,
      bio,
      mail,
      keepVerified ? current.email_verified_at : 0,
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
    const row = db.prepare('SELECT pass_hash, password_set FROM users WHERE id = ?').get(user.id);
    // 第三方登录自动创建的账号没有密码（password_set = 0），首次设置不需要旧密码；
    // 已经设置过密码的账号必须先验证旧密码，防止会话被借用后直接改密码。
    if (row.password_set !== 0 && !verifyPassword(current, row.pass_hash)) {
      throw badRequest('当前密码不正确', 'bad_password');
    }
    db.prepare('UPDATE users SET pass_hash = ?, password_set = 1 WHERE id = ?').run(hashPassword(next), user.id);
    // 改完密码把其他设备踢下线
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, ctx.token || '');
    return { ok: true };
  });

  // 邮箱验证码 · 第一步：发送验证码到填写的邮箱（10 分钟内有效）
  router.post('/api/me/email/code', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`email-code-60s:${user.id}`, 1, 60 * 1000, '发送太频繁');
    enforce(`email-code-hour:${user.id}`, 5, 60 * 60 * 1000, '发送太频繁');
    enforce(`email-code-ip:${ctx.ip}`, 10, 60 * 60 * 1000, '发送太频繁');

    const body = await ctx.json();
    const mail = emailField(body.email);
    if (!mail) throw badRequest('请先填写邮箱地址', 'email_required');
    if (user.email_verified_at && user.email && user.email.toLowerCase() === mail.toLowerCase()) {
      throw badRequest('这个邮箱已经验证过了', 'email_already_verified');
    }

    const { code, expiresIn } = issueEmailCode(mail);
    await sendMail({
      to: mail,
      subject: `【${config.siteName}】邮箱验证码`,
      text:
        `你正在${config.siteName}验证邮箱地址。\n\n` +
        `验证码：${code}\n\n` +
        `${Math.round(EMAIL_CODE_TTL / 60)} 分钟内有效。请勿把验证码告诉任何人。\n` +
        `如果不是你本人的操作，请忽略这封邮件。`,
    });
    return { ok: true, expires_in: expiresIn };
  });

  // 邮箱验证码 · 第二步：校验验证码，通过后绑定邮箱并标记已验证
  router.post('/api/me/email/verify', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`email-verify:${user.id}`, 10, 60 * 60 * 1000, '验证尝试太频繁');

    const body = await ctx.json();
    const mail = emailField(body.email);
    if (!mail) throw badRequest('请先填写邮箱地址', 'email_required');
    if (emailTakenBy(mail, user.id)) throw badRequest('这个邮箱已经被别的账号用过了', 'email_taken');

    const result = consumeEmailCode(mail, String(body.code || ''));
    if (!result.ok) throw badRequest(result.message, 'email_code_invalid');

    db.prepare('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?').run(mail, now(), user.id);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    return { user: publicUser(row, { self: true }) };
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
