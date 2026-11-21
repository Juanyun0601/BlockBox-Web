/**
 * 方块充值冒烟测试：临时库起一个服务，跑下单签名 → 回调到账 → 重复回调幂等 → 金额/签名拒绝
 * 用法：npm run pay:smoke
 *
 * 用的是假的商户号（PAY_PID / PAY_KEY），所以不会真的联网下单：
 * 只验证拼出来的收银台地址、签名规则和「回调加方块」这条主链路。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bbf-pay-'));

const PID = '1001';
const KEY = 'pay-smoke-test-key';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/** 按文档规则独立算一遍签名：参数名升序、值不编码、末尾接密钥、小写 MD5 */
function sign(params) {
  const text = Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .filter((key) => params[key] !== undefined && params[key] !== null && String(params[key]) !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('md5').update(`${text}${KEY}`, 'utf8').digest('hex');
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: path.join(tempRoot, 'forum.db'),
      UPLOAD_DIR: path.join(tempRoot, 'uploads'),
      ANNOUNCEMENT_FILE: path.join(tempRoot, 'announcement.json'),
      PUBLIC_ORIGIN: 'https://forum.example.com',
      LOG_REQUESTS: '0',
      SESSION_DAYS: '1',
      // 这条用例只关心支付，注册流程从简
      REGISTER_EMAIL_REQUIRED: '0',
      HUMAN_CHECK: '0',
      PAY_PID: PID,
      PAY_KEY: KEY,
      PAY_TYPES: '',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const cleanup = () => {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  check('服务启动', ready, '10 秒内没有响应 /api/health');
  if (!ready) return;

  let cookie = '';
  async function request(method, urlPath, body) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, json, text };
  }

  // 注册一个账号（首个账号自动是管理员）
  const registered = await request('POST', '/api/auth/register', {
    username: 'paysmoke',
    password: 'Passw0rd!',
    email: '',
  });
  check('注册账号并登录', registered.status === 200, JSON.stringify(registered.json));

  // 档位
  const shop = await request('GET', '/api/points/shop');
  check('充值通道已开通', shop.json?.enabled === true, JSON.stringify(shop.json));
  const packages = shop.json?.packages || [];
  check('四个档位都在', packages.length === 4, JSON.stringify(packages.map((item) => item.id)));
  check(
    '小额包 600 方块 ¥6.00',
    packages.some((item) => item.id === 'p600' && item.points === 600 && item.price === '6.00'),
    JSON.stringify(packages),
  );
  check(
    '常用包 3300 方块 ¥30.00',
    packages.some((item) => item.id === 'p3300' && item.points === 3300 && item.price === '30.00'),
    JSON.stringify(packages),
  );
  check(
    '高频包 8000 方块 ¥68.00',
    packages.some((item) => item.id === 'p8000' && item.points === 8000 && item.price === '68.00'),
    JSON.stringify(packages),
  );
  check(
    '重度包 16000 方块 ¥128.00',
    packages.some((item) => item.id === 'p16000' && item.points === 16000 && item.price === '128.00'),
    JSON.stringify(packages),
  );

  // 下单
  const created = await request('POST', '/api/points/shop/order', { package: 'p600' });
  check('下单成功', created.status === 200, JSON.stringify(created.json));
  const order = created.json?.order || {};
  const payUrl = created.json?.pay_url || '';
  check('拿到收银台地址', payUrl.startsWith('https://pay.ykmcn.com/submit.php?'), payUrl);
  const query = Object.fromEntries(new URL(payUrl).searchParams.entries());
  check('地址带商户号', query.pid === PID, JSON.stringify(query));
  check('商品名带档位和数量', query.name === '小额包 600 方块', String(query.name));
  check('金额是两位小数', query.money === '6.00', String(query.money));
  check(
    '回调地址指向本站',
    query.notify_url === 'https://forum.example.com/api/pay/notify',
    String(query.notify_url),
  );
  check('回跳地址带订单号', String(query.return_url || '').includes(order.out_trade_no), String(query.return_url));
  check('签名可以复算', sign(query) === query.sign, `${sign(query)} / ${query.sign}`);

  const pending = await request('GET', `/api/points/shop/order/${order.out_trade_no}`);
  check('刚下单是待支付', pending.json?.order?.status === 'pending', JSON.stringify(pending.json?.order));
  check('付款前方块为 0', pending.json?.points === 0, String(pending.json?.points));

  // 回调到账
  const notifyParams = {
    pid: PID,
    trade_no: 'T-SMOKE-1',
    out_trade_no: order.out_trade_no,
    type: 'alipay',
    name: '小额包 600 方块',
    money: '6.00',
    trade_status: 'TRADE_SUCCESS',
  };
  notifyParams.sign = sign(notifyParams);
  notifyParams.sign_type = 'MD5';
  const notifyRes = await fetch(`${base}/api/pay/notify?${new URLSearchParams(notifyParams).toString()}`);
  check('回调返回 success', (await notifyRes.text()).trim() === 'success');

  const afterPay = await request('GET', '/api/points');
  check('方块到账 600', afterPay.json?.points === 600, String(afterPay.json?.points));

  const againRes = await fetch(`${base}/api/pay/notify?${new URLSearchParams(notifyParams).toString()}`);
  check('重复回调仍回 success', (await againRes.text()).trim() === 'success');
  const afterAgain = await request('GET', '/api/points');
  check('重复回调不重复加方块', afterAgain.json?.points === 600, String(afterAgain.json?.points));

  const paid = await request('GET', `/api/points/shop/order/${order.out_trade_no}`);
  check('订单变成已支付', paid.json?.order?.status === 'paid', JSON.stringify(paid.json?.order));

  // 拒绝伪造 / 篡改
  const forged = { ...notifyParams, sign: 'deadbeefdeadbeefdeadbeefdeadbeef' };
  const forgedRes = await fetch(`${base}/api/pay/notify?${new URLSearchParams(forged).toString()}`);
  check('签名不对被拒绝', (await forgedRes.text()).trim() === 'fail');

  const second = await request('POST', '/api/points/shop/order', { package: 'p3300' });
  const secondNo = second.json?.order?.out_trade_no || '';
  check('常用包下单成功', !!secondNo, JSON.stringify(second.json));
  const wrongMoney = {
    pid: PID,
    trade_no: 'T-SMOKE-2',
    out_trade_no: secondNo,
    type: 'wxpay',
    name: '常用包 3300 方块',
    money: '0.01',
    trade_status: 'TRADE_SUCCESS',
  };
  wrongMoney.sign = sign(wrongMoney);
  const wrongRes = await fetch(`${base}/api/pay/notify?${new URLSearchParams(wrongMoney).toString()}`);
  check('金额不符被拒绝', (await wrongRes.text()).trim() === 'fail');
  const afterWrong = await request('GET', '/api/points');
  check('被拒的回调不影响余额', afterWrong.json?.points === 600, String(afterWrong.json?.points));

  const goodSecond = { ...wrongMoney, money: '30.00' };
  delete goodSecond.sign;
  goodSecond.sign = sign(goodSecond);
  const goodRes = await fetch(`${base}/api/pay/notify?${new URLSearchParams(goodSecond).toString()}`);
  check('常用包回调 success', (await goodRes.text()).trim() === 'success');
  const afterSecond = await request('GET', '/api/points');
  check('再 +3300 方块', afterSecond.json?.points === 3900, String(afterSecond.json?.points));

  // 未登录不能下单
  const savedCookie = cookie;
  cookie = '';
  const anonymous = await request('POST', '/api/points/shop/order', { package: 'p600' });
  cookie = savedCookie;
  check('未登录下单被拒绝', anonymous.status === 401, String(anonymous.status));

  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n共 ${results.length} 项，失败 ${failed} 项`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
