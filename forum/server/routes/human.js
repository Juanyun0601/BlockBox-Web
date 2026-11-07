/**
 * 人机验证接口：滑块拼图。
 *
 * 网页端和启动器走同一套：
 *   GET  /api/human/status     查一下当前还要不要验证、免验还剩多久
 *   GET  /api/human/challenge  拿一道题（背景图 + 拼图）
 *   POST /api/human/verify     交答案，对了就发令牌
 *
 * 通过后网页端拿 Cookie（bbf_hv），启动器拿 X-Human-Token 请求头，二者等价。
 */
import { config } from '../config.js';
import { HttpError, serializeCookie } from '../lib/http.js';
import { enforce } from '../lib/rate-limit.js';
import {
  HUMAN_COOKIE,
  issueChallenge,
  remainingSeconds,
  verifyAnswer,
} from '../lib/human-check.js';

export default function register(router) {
  router.get('/api/human/status', async (ctx) => {
    if (!config.humanCheck.enabled) {
      return { enabled: false, verified: true, remaining: 0, ttl_hours: 0 };
    }
    const remaining = Math.max(
      remainingSeconds(ctx.cookies[HUMAN_COOKIE]),
      remainingSeconds(ctx.req.headers['x-human-token']),
    );
    return {
      enabled: true,
      verified: remaining > 0,
      remaining,
      ttl_hours: config.humanCheck.ttlHours,
    };
  });

  router.get('/api/human/challenge', async (ctx) => {
    enforce(`human-challenge:${ctx.ip}`, 60, 60 * 1000, '验证题要得太频繁');
    return issueChallenge();
  });

  router.post('/api/human/verify', async (ctx) => {
    enforce(`human-verify:${ctx.ip}`, 40, 60 * 1000, '验证提交太频繁');
    const body = await ctx.json();
    const result = verifyAnswer({ id: body.id, answer: body.answer, duration: body.duration });
    if (!result.ok) {
      throw new HttpError(400, result.message, result.reason);
    }

    const maxAge = Math.max(1, result.expires - Math.floor(Date.now() / 1000));
    ctx.res.setHeader(
      'set-cookie',
      serializeCookie(HUMAN_COOKIE, result.token, {
        maxAge,
        httpOnly: true,
        sameSite: 'Lax',
        secure: config.secureCookie,
      }),
    );
    return { ok: true, token: result.token, expires: result.expires, expires_in: maxAge };
  });
}
