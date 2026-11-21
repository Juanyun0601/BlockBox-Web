/**
 * 方块充值接口
 *
 *   GET  /api/points/shop                 可买档位 + 支付方式 + 是否已开通
 *   POST /api/points/shop/order           下单，返回收银台地址
 *   GET  /api/points/shop/order/:no       查订单状态（顺带主动向支付方查一次单）
 *   GET  /api/pay/notify                  支付方异步通知（验签后加方块，回 success）
 *
 * 客户端（启动器 / 网页）只拿支付地址，商户密钥始终留在服务端。
 */
import { enforce } from '../lib/rate-limit.js';
import { requireUser } from '../lib/auth.js';
import { badRequest } from '../lib/http.js';
import { getPointsState } from '../lib/points.js';
import {
  createOrder,
  handleNotify,
  orderStatus,
  payReady,
  publicBase,
  recentOrders,
  shopState,
} from '../lib/pay.js';

export default function register(router) {
  // 购买页的档位列表（没配置商户号时 enabled=false，两端会自动隐藏入口）
  router.get('/api/points/shop', async (ctx) => {
    const user = requireUser(ctx.user);
    return { ...shopState(), recent: recentOrders(user.id, 5), points: getPointsState(user.id).points };
  });

  // 下单：半小时内同一账号最多下 20 单，防止脚本刷单
  router.post('/api/points/shop/order', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`points-recharge:${user.id}`, 20, 30 * 60 * 1000, '下单太频繁，稍后再试');
    if (!payReady()) throw badRequest('充值通道还没开通，先参加每日签到领方块吧', 'pay_disabled');
    const body = await ctx.json();
    const result = createOrder(user.id, {
      packageId: body.package || body.package_id || body.id,
      type: body.type || '',
      ip: ctx.ip,
      base: publicBase(ctx.req),
    });
    return {
      ...result,
      points: getPointsState(user.id).points,
    };
  });

  // 查订单：付完款后两端都靠它确认到账
  router.get('/api/points/shop/order/:outTradeNo', async (ctx) => {
    const user = requireUser(ctx.user);
    const order = await orderStatus(user.id, ctx.params.outTradeNo, publicBase(ctx.req));
    return { order, points: getPointsState(user.id).points };
  });

  // 支付方异步通知：必须是纯文本 success，所以这里自己写响应，不走统一的 JSON 包装。
  // 订单号不存在 / 验签失败回 fail，让支付方知道没处理成功。
  router.get('/api/pay/notify', async (ctx) => {
    let ok = false;
    try {
      ok = handleNotify(Object.fromEntries(ctx.url.searchParams.entries()));
    } catch (error) {
      console.error('[支付] 处理回调出错：', error.message);
      ok = false;
    }
    const body = ok ? 'success' : 'fail';
    ctx.res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    ctx.res.end(body);
  });
}
