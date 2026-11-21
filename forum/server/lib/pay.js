/**
 * 方块充值（源开易支付）
 *
 * 文档：https://pay.ykmcn.com/doc/index.html
 * 走的是 V1 接口（MD5 签名）：
 *   - 下单：把签名好的参数拼成 submit.php 的地址交给浏览器，用户在收银台选支付宝 / 微信付款；
 *   - 到账：支付方回调 /api/pay/notify（GET），验签 + 核对金额后给账号加方块；
 *   - 兜底：回调没到或本地调试收不到回调时，主动用 api.php?act=order 查一次单，
 *     查到已支付就同样加方块（两处都走 creditOrder，重复触发只会到账一次）。
 *
 * 商户号与密钥只存在服务端 .env 里，客户端永远只拿到一个支付地址。
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, now, transaction } from '../db.js';
import { badRequest, notFound } from './http.js';
import { notifyAdminMessage } from './notify.js';

/**
 * 可购买的方块档位。
 * 价格用「元」的字符串（两位小数）原样传给支付方，cents 只用来做金额比对。
 */
export const POINT_PACKAGES = [
  { id: 'p600', name: '小额包', points: 600, price: '6.00' },
  { id: 'p3300', name: '常用包', points: 3300, price: '30.00' },
  { id: 'p8000', name: '高频包', points: 8000, price: '68.00' },
  { id: 'p16000', name: '重度包', points: 16000, price: '128.00' },
].map((item) => ({ ...item, cents: Math.round(Number(item.price) * 100) }));

/** 金额（元）转分；接受 "6.00" / 6 / "6" 这类写法 */
export const toCents = (value) => Math.round(Number(value) * 100) || 0;

/** 某个档位，找不到返回 null */
export function findPackage(id) {
  const key = String(id || '').trim().toLowerCase();
  return POINT_PACKAGES.find((item) => item.id === key) || null;
}

/** 商品名：给收银台显示，例如「小额包 600 方块」 */
export function packageTitle(pkg) {
  return `${pkg.name} ${pkg.points} 方块`;
}

/**
 * MD5 签名（V1 规则）：
 *   1. 参与签名的参数按参数名 ASCII 升序排；
 *   2. 拼成 a=b&c=d 的形式，值不做 URL 编码；
 *   3. 末尾接上商户密钥再 MD5，结果小写。
 * sign、sign_type 与空值不参与签名。
 */
export function md5Sign(params, key) {
  const text = Object.keys(params)
    .filter((name) => name !== 'sign' && name !== 'sign_type')
    .filter((name) => {
      const value = params[name];
      return value !== undefined && value !== null && String(value) !== '';
    })
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join('&');
  return crypto.createHash('md5').update(`${text}${key}`, 'utf8').digest('hex');
}

/** 校验签名（大小写不敏感，支付方偶尔会回大写 MD5） */
export function verifySign(params, key) {
  const given = String(params.sign || '').trim().toLowerCase();
  if (!given) return false;
  return md5Sign(params, key) === given;
}

/**
 * 回调 / 跳转回站要用的公网地址。
 * 优先 PAY_NOTIFY_BASE，其次按请求的 Host 现算（本机调试时就是 127.0.0.1）。
 */
export function publicBase(req) {
  if (config.pay.notifyBase) return config.pay.notifyBase;
  const headers = (req && req.headers) || {};
  const forwarded = String(headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwarded || (req && req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = String(headers.host || 'localhost');
  return `${proto}://${host}`;
}

/** 支付功能是否已配置好（客户端按这个决定要不要显示购买入口） */
export const payReady = () => !!config.pay.enabled && !!config.pay.pid && !!config.pay.key;

/** 购买页要的数据：档位、支付方式、是否可用 */
export function shopState() {
  return {
    enabled: payReady(),
    name: '方块',
    packages: POINT_PACKAGES.map((item) => ({
      id: item.id,
      name: item.name,
      points: item.points,
      price: item.price,
      cents: item.cents,
    })),
    methods: config.pay.types.slice(),
    note: payReady()
      ? '支付完成后方块自动到账，一般几秒内就会刷新。'
      : '充值通道还没开通，先参加每日签到领方块吧。',
  };
}

/** 商户订单号：BB + 年月日时分秒 + 6 位随机，20 位，符合支付方的唯一性要求 */
function newTradeNo() {
  const now2 = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  const stamp =
    pad(now2.getFullYear() % 100) +
    pad(now2.getMonth() + 1) +
    pad(now2.getDate()) +
    pad(now2.getHours()) +
    pad(now2.getMinutes()) +
    pad(now2.getSeconds());
  return `BB${stamp}${pad(crypto.randomInt(0, 1000000), 6)}`;
}

/**
 * 把一笔订单拼成收银台地址（页面跳转支付）。
 * 不指定支付方式时跳收银台，让用户自己选支付宝还是微信。
 */
export function payUrlFor(order, base) {
  const params = {
    pid: config.pay.pid,
    out_trade_no: order.out_trade_no,
    notify_url: `${base}/api/pay/notify`,
    return_url: `${base}/points.html?pay=${encodeURIComponent(order.out_trade_no)}`,
    name: order.title,
    money: order.money,
    sign_type: 'MD5',
  };
  if (order.pay_type) params.type = order.pay_type;
  params.sign = md5Sign(params, config.pay.key);
  return `${config.pay.gateway}/submit.php?${new URLSearchParams(params).toString()}`;
}

/** 下单库里的一行转成对外结构 */
function orderView(row, base) {
  return {
    out_trade_no: row.out_trade_no,
    package_id: row.package_id,
    package_name: row.package_name,
    points: Number(row.points) || 0,
    price: row.money,
    status: row.status,
    pay_type: row.pay_type,
    trade_no: row.trade_no,
    created_at: row.created_at,
    paid_at: row.paid_at,
    payable: row.status === 'pending' && !!config.pay.pid,
    pay_url: row.status === 'pending' ? payUrlFor({ ...row, title: titleOf(row) }, base) : '',
  };
}

const titleOf = (row) => `${row.package_name} ${row.points} 方块`;

/**
 * 创建一笔充值订单。
 * @param {number} userId 账号 id
 * @param {object} options packageId 档位标识；type 支付方式（可空）；ip 发起支付的 IP；base 公网地址
 */
export function createOrder(userId, { packageId, type = '', ip = '', base = '' } = {}) {
  if (!payReady()) throw badRequest('充值通道还没开通，先参加每日签到领方块吧', 'pay_disabled');

  const pkg = findPackage(packageId);
  if (!pkg) throw badRequest('没有这个充值档位', 'bad_package');

  const payType = String(type || '').trim().toLowerCase();
  if (payType && config.pay.types.length > 0 && !config.pay.types.includes(payType)) {
    throw badRequest('暂不支持这种支付方式', 'bad_pay_type');
  }

  const outTradeNo = newTradeNo();
  const timestamp = now();
  try {
    db.prepare(
      `INSERT INTO point_orders
         (out_trade_no, user_id, package_id, package_name, points, money, money_cents,
          pay_type, status, client_ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      outTradeNo,
      userId,
      pkg.id,
      pkg.name,
      pkg.points,
      pkg.price,
      pkg.cents,
      payType,
      String(ip || '').slice(0, 64),
      timestamp,
    );
  } catch (error) {
    // 订单号撞车（几乎不会）：让用户再点一次就好
    if (String(error.message || '').includes('UNIQUE')) {
      throw badRequest('订单号生成冲突，请再试一次', 'order_conflict');
    }
    throw error;
  }

  const row = db.prepare('SELECT * FROM point_orders WHERE out_trade_no = ?').get(outTradeNo);
  const view = orderView(row, base || config.pay.notifyBase);
  return { order: view, pay_url: view.pay_url };
}

/**
 * 给订单记上「已支付」并发方块。
 * @returns {{credited:boolean, order:object}|null} 订单不存在返回 null；
 *          重复调用（回调 + 主动查单都命中）只有第一次 credited 为 true。
 */
export function creditOrder(outTradeNo, { tradeNo = '', ip = '' } = {}) {
  const order = db.prepare('SELECT * FROM point_orders WHERE out_trade_no = ?').get(outTradeNo);
  if (!order) return null;
  if (order.status === 'paid') return { credited: false, order };

  let credited = false;
  transaction(() => {
    const changed = db
      .prepare(
        `UPDATE point_orders
            SET status = 'paid', trade_no = CASE WHEN ? <> '' THEN ? ELSE trade_no END,
                paid_at = ?, paid_ip = ?
          WHERE out_trade_no = ? AND status = 'pending'`,
      )
      .run(String(tradeNo || ''), String(tradeNo || ''), now(), String(ip || '').slice(0, 64), outTradeNo);
    if (Number(changed.changes) < 1) return;

    db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(
      Number(order.points) || 0,
      order.user_id,
    );
    db.prepare(
      `INSERT INTO point_transactions (user_id, amount, kind, note, created_at)
       VALUES (?, ?, 'recharge', ?, ?)`,
    ).run(order.user_id, Number(order.points) || 0, `充值 ${titleOf(order)}`, now());
    credited = true;
  });

  const fresh = db.prepare('SELECT * FROM point_orders WHERE out_trade_no = ?').get(outTradeNo);
  if (credited) {
    try {
      notifyAdminMessage(
        order.user_id,
        '方块已到账',
        `你充值的 ${titleOf(order)} 已到账（¥${order.money}），现在可以拿去打赏、发有奖问答或买补签卡。`,
      );
    } catch (error) {
      // 通知失败不影响到账
      console.error('[支付] 到账通知写入失败：', error.message);
    }
  }
  return { credited, order: fresh };
}

/**
 * 处理支付方的异步通知（GET 参数）。
 * 验签 + 核对商户号 / 金额 / 支付状态，通过后再加方块。
 * @returns {boolean} 是否是一笔刚处理完的有效通知（回调方据此回 success）
 */
export function handleNotify(query) {
  const params = {};
  for (const [key, value] of Object.entries(query || {})) {
    params[key] = Array.isArray(value) ? String(value[0]) : String(value ?? '');
  }
  if (!payReady()) {
    console.warn('[支付] 收到回调，但商户号 / 密钥没配置，已忽略');
    return false;
  }
  if (!verifySign(params, config.pay.key)) {
    console.warn(`[支付] 回调签名不对，已忽略：out_trade_no=${params.out_trade_no || ''}`);
    return false;
  }
  if (String(params.pid) !== String(config.pay.pid)) {
    console.warn(`[支付] 回调商户号不匹配：${params.pid || ''}`);
    return false;
  }

  const order = db.prepare('SELECT * FROM point_orders WHERE out_trade_no = ?').get(params.out_trade_no || '');
  if (!order) {
    console.warn(`[支付] 回调的订单不存在：${params.out_trade_no || ''}`);
    return false;
  }
  if (String(params.trade_status || '') !== 'TRADE_SUCCESS') {
    // 未支付 / 已关闭等状态不改余额，回 success 免得对方一直重试
    return true;
  }
  if (params.money && toCents(params.money) !== Number(order.money_cents)) {
    console.warn(
      `[支付] 回调金额和订单不一致：订单 ¥${order.money}，回调 ¥${params.money}（${order.out_trade_no}）`,
    );
    return false;
  }

  creditOrder(order.out_trade_no, { tradeNo: params.trade_no || '', ip: params.clientip || '' });
  return true;
}

const SYNC_MIN_INTERVAL = 6;
const SYNC_MAX_TIMES = 40;
const syncState = new Map(); // out_trade_no -> { at, times }

/**
 * 主动向支付方查一次单，已支付就加方块。
 * 回调没配好、或用户付款后关了页面都能靠它兜底。
 *
 * 网页和启动器都会每几秒轮询一次，这里对同一笔订单做节流：
 *   - 6 秒内最多查一次支付方；
 *   - 一笔订单最多主动查 40 次（约 4 分钟），之后只等回调，别再烧对方的接口。
 * @returns {Promise<string>} 查完后的订单状态（pending / paid / closed）
 */
export async function syncOrder(outTradeNo) {
  const order = db.prepare('SELECT * FROM point_orders WHERE out_trade_no = ?').get(outTradeNo);
  if (!order) return '';
  if (order.status !== 'pending' || !payReady()) return order.status;
  // 超过保护期就不再打支付方接口：既省调用，也避免有人拿旧订单一直轮询
  if (now() - Number(order.created_at) > config.pay.orderTtl) return 'pending';

  const state = syncState.get(order.out_trade_no) || { at: 0, times: 0 };
  if (state.times >= SYNC_MAX_TIMES) return 'pending';
  if (state.at && now() - state.at < SYNC_MIN_INTERVAL) return 'pending';
  state.at = now();
  state.times += 1;
  syncState.set(order.out_trade_no, state);
  if (syncState.size > 500) {
    // 顺手清掉已经结束的订单，别让这张表一直长
    for (const [key, item] of syncState) {
      if (item.times >= SYNC_MAX_TIMES) syncState.delete(key);
    }
  }

  const url = new URL(`${config.pay.gateway}/api.php`);
  url.searchParams.set('act', 'order');
  url.searchParams.set('pid', config.pay.pid);
  url.searchParams.set('key', config.pay.key);
  url.searchParams.set('out_trade_no', order.out_trade_no);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return 'pending';
    const data = await response.json();
    if (Number(data.code) !== 1) return 'pending';
    if (Number(data.status) !== 1) return 'pending';
    // 查单返回的金额也要对得上，防止串单
    if (data.money && toCents(data.money) !== Number(order.money_cents)) {
      console.warn(`[支付] 查单金额和订单不一致：${order.out_trade_no}`);
      return 'pending';
    }
    creditOrder(order.out_trade_no, { tradeNo: data.trade_no || '', ip: order.client_ip || '' });
    syncState.delete(order.out_trade_no);
    return 'paid';
  } catch (error) {
    // 支付方接口抖动不影响用户：下一轮轮询再查
    console.warn('[支付] 查单失败：', error.message);
    return 'pending';
  }
}

/** 取一笔订单（限定本人），顺带做一次主动查单 */
export async function orderStatus(userId, outTradeNo, base = '') {
  const row = db.prepare('SELECT * FROM point_orders WHERE out_trade_no = ? AND user_id = ?').get(
    String(outTradeNo || ''),
    userId,
  );
  if (!row) throw notFound('订单不存在');
  if (row.status === 'pending') await syncOrder(row.out_trade_no);
  const fresh = db.prepare('SELECT * FROM point_orders WHERE out_trade_no = ?').get(row.out_trade_no);
  return orderView(fresh, base || config.pay.notifyBase);
}

/** 当前账号最近的充值记录（网页 / 启动器都能看「最近充值」） */
export function recentOrders(userId, limit = 5) {
  const rows = db
    .prepare(
      `SELECT * FROM point_orders
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(userId, Math.max(1, Math.min(20, Number(limit) || 5)));
  return rows.map((row) => ({
    out_trade_no: row.out_trade_no,
    package_name: row.package_name,
    points: Number(row.points) || 0,
    price: row.money,
    status: row.status,
    created_at: row.created_at,
    paid_at: row.paid_at,
  }));
}
