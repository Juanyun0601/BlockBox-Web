import { db, now } from '../db.js';
import { badRequest, notFound, unauthorized } from '../lib/http.js';
import { enforce } from '../lib/rate-limit.js';
import {
  buildAuthorizeUrl,
  callbackUrl,
  consumeOAuthState,
  createDevice,
  createOAuthState,
  deviceByUserCode,
  deviceStatus,
  enabledProviders,
  exchangeCode,
  failDevice,
  fetchProfile,
  isProviderEnabled,
  listOAuthLinks,
  providerMeta,
  providerStatus,
  requestOrigin,
  resolveOAuthUser,
  safeNext,
  unlinkOAuthProvider,
} from '../lib/oauth.js';
import { createSession, destroySession, publicUser, requireUser, sessionCookie } from '../lib/auth.js';

/** 302 跳转（OAuth 的起点和回调都要直接改地址，不能回 JSON） */
function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

/** 把用户送回登录页并带上可读的错误说明 */
function redirectLoginError(res, message, next = '/') {
  const query = new URLSearchParams({ oauth_error: String(message || '登录失败'), next: safeNext(next) });
  redirect(res, `/login.html?${query.toString()}`);
}

/** 启动器设备码流程的错误：转到结果页并让启动器轮询到 failed */
function redirectDeviceError(res, message) {
  const query = new URLSearchParams({ status: 'error', message: String(message || '登录失败') });
  redirect(res, `/oauth/done.html?${query.toString()}`);
}

function redirectDeviceSuccess(res, provider) {
  const query = new URLSearchParams({ status: 'ok', provider });
  redirect(res, `/oauth/done.html?${query.toString()}`);
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message;
  return '登录失败，请稍后再试';
}

export default function register(router) {
  // 登录页据此显示哪些第三方入口（未配置客户端 ID / Secret 的自动隐藏）
  router.get('/api/auth/oauth/providers', async () => ({
    providers: providerStatus(),
    enabled: enabledProviders().map((item) => item.id),
  }));

  // 启动器发起第三方登录：申请一对设备码，浏览器授权后启动器凭 device_code 取会话
  router.post('/api/auth/oauth/device', async (ctx) => {
    enforce(`oauth-device:${ctx.ip}`, 20, 10 * 60 * 1000, '发起登录太频繁');
    const body = await ctx.json();
    const provider = String(body.provider || '').trim().toLowerCase();
    if (!isProviderEnabled(provider)) throw badRequest('这个登录方式暂时不可用', 'oauth_disabled');
    return createDevice(provider, requestOrigin(ctx.req));
  });

  // 启动器轮询授权结果（device_code 本身就是密钥，不需要登录态）。
  // 放在 POST 请求体里而不是 URL 上：访问日志默认会记完整 URL，别把登录凭据写进日志。
  const deviceStatusPayload = (deviceCode) => {
    const row = deviceStatus(deviceCode);
    if (!row) throw notFound('登录请求不存在或已过期');
    if (row.status === 'authorized') {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
      if (!user) return { status: 'failed', message: '账号不存在或已被删除' };
      return {
        status: 'authorized',
        token: row.session_token,
        user: publicUser(user, { self: true }),
      };
    }
    if (row.status === 'pending') {
      return { status: 'pending', expires_in: Math.max(0, Number(row.expires_at) - now()) };
    }
    return { status: row.status, message: row.message || '登录已失效，请重新发起' };
  };
  router.post('/api/auth/oauth/device/status', async (ctx) => {
    const body = await ctx.json();
    return deviceStatusPayload(body.device_code);
  });
  // 保留 GET 版本方便手工排查；启动器统一用上面的 POST，避免凭据进入访问日志
  router.get('/api/auth/oauth/device/status', async (ctx) =>
    deviceStatusPayload(ctx.url.searchParams.get('device_code')),
  );

  // 已登录账号的第三方绑定列表
  router.get('/api/me/oauth', async (ctx) => {
    const user = requireUser(ctx.user);
    return { providers: providerStatus(), links: listOAuthLinks(user.id) };
  });

  router.delete('/api/me/oauth/:provider', async (ctx) => {
    const user = requireUser(ctx.user);
    const links = unlinkOAuthProvider(user.id, ctx.params.provider);
    return { ok: true, links };
  });

  // 浏览器起点：跳到 GitHub / LittleSkin 的授权页
  router.get('/oauth/start/:provider', async (ctx) => {
    const provider = String(ctx.params.provider || '').toLowerCase();
    const next = safeNext(ctx.url.searchParams.get('next') || '/');
    const deviceUserCode = String(ctx.url.searchParams.get('device') || '');
    let device = null;

    try {
      if (!isProviderEnabled(provider)) {
        throw badRequest(`还没有配置 ${providerMeta(provider).name} 登录，请联系站点管理员`, 'oauth_disabled');
      }
      if (deviceUserCode) {
        device = deviceByUserCode(deviceUserCode, provider);
        if (!device) throw badRequest('启动器登录请求已过期，请回到启动器重新发起', 'oauth_device_expired');
      }

      const bind = ctx.url.searchParams.get('bind') === '1';
      if (bind && !ctx.user) throw unauthorized('请先登录方块盒子账号再绑定第三方账号');

      const redirectUri = callbackUrl(ctx.req, provider);
      const state = createOAuthState({
        provider,
        redirectUri,
        nextPath: next,
        deviceCode: device ? device.device_code : '',
        bindUserId: bind && ctx.user ? ctx.user.id : 0,
      });
      redirect(ctx.res, buildAuthorizeUrl(provider, state, redirectUri));
    } catch (error) {
      if (device) failDevice(device.device_code, errorMessage(error));
      if (device) redirectDeviceError(ctx.res, errorMessage(error));
      else redirectLoginError(ctx.res, errorMessage(error), next);
    }
  });

  // 服务商回调：换令牌、读资料、找到 / 创建账号、种下会话
  router.get('/oauth/callback/:provider', async (ctx) => {
    const provider = String(ctx.params.provider || '').toLowerCase();
    let state = null;
    let next = '/';

    try {
      state = consumeOAuthState(ctx.url.searchParams.get('state'), provider);
      if (!state) throw badRequest('登录链接已过期或无效，请重新发起', 'oauth_state_invalid');
      next = safeNext(state.next_path || '/');

      const providerError = ctx.url.searchParams.get('error');
      if (providerError) {
        const detail = ctx.url.searchParams.get('error_description') || providerError;
        throw badRequest(`第三方登录未完成：${detail}`, 'oauth_denied');
      }

      const code = ctx.url.searchParams.get('code');
      if (!code) throw badRequest('第三方登录没有返回授权码，请重试', 'oauth_no_code');

      const accessToken = await exchangeCode(provider, code, state.redirect_uri);
      const profile = await fetchProfile(provider, accessToken);
      const { user, created, linked } = resolveOAuthUser({
        provider,
        profile,
        bindUserId: state.bind_user_id,
        browserUserId: ctx.user ? ctx.user.id : 0,
      });

      // 启动器流程单独发一个会话，浏览器退出登录不会把启动器一起踢掉
      if (state.device_code) {
        const launcherSession = createSession(user.id, { ip: ctx.ip, ua: 'BlockBox Launcher' });
        const saved = db
          .prepare(
            `UPDATE oauth_devices
                SET status = 'authorized', user_id = ?, session_token = ?, message = ''
              WHERE device_code = ? AND status = 'pending' AND expires_at > ?`,
          )
          .run(user.id, launcherSession.token, state.device_code, now());
        if (Number(saved.changes) > 0) {
          redirectDeviceSuccess(ctx.res, provider);
          return;
        }
        // 设备码已经过期 / 已失效：刚发的启动器会话用不上了，删掉别留垃圾
        destroySession(launcherSession.token);
        redirectDeviceError(ctx.res, '启动器登录请求已过期，请回到启动器重新发起');
        return;
      }

      const browserSession = createSession(user.id, { ip: ctx.ip, ua: ctx.userAgent });
      sessionCookie(ctx.res, browserSession.token, browserSession.expiresAt);

      // 回跳地址可能带 #楼层锚点，用 URL 对象拼参数，避免把 ?oauth_xxx 塞到 # 后面
      const target = new URL(next, 'http://blockbox.local');
      if (created) target.searchParams.set('oauth_created', provider);
      else if (linked) target.searchParams.set('oauth_linked', provider);
      else target.searchParams.set('oauth_login', provider);
      redirect(ctx.res, `${target.pathname}${target.search}${target.hash}`);
    } catch (error) {
      const message = errorMessage(error);
      if (state && state.device_code) {
        failDevice(state.device_code, message);
        redirectDeviceError(ctx.res, message);
        return;
      }
      redirectLoginError(ctx.res, message, next);
    }
  });
}
