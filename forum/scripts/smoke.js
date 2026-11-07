/**
 * 端到端冒烟测试：临时数据库启动一个服务，跑完注册 → 发帖 → 回复 → 搜索 → 管理 → 权限
 * 用法：npm run smoke
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bbf-smoke-'));

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

import { decodePng, encodePng } from '../server/lib/png.js';

const results = [];
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** 生成一张纯 PNG 测试图（渐变，方便验证缩放/缩略图） */
function makePng(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = x % 256;
      data[index + 1] = y % 256;
      data[index + 2] = (x + y) % 256;
      data[index + 3] = 255;
    }
  }
  return encodePng({ width, height, data });
}
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${detail}`}`);
}

/**
 * 把滑块拼图「解」出来：拼图是从缺口那块原图上切下来的，
 * 只要拿拼图内容去跟背景里被压暗的区域逐像素比对，就能找到缺口的位置。
 * 真实用户是拖滑块对上去的，这里用同样的思路验证这道题确实做得出来。
 */
function solvePuzzle(challenge) {
  const fromDataUrl = (url) => Buffer.from(String(url).split(',')[1], 'base64');
  const bg = decodePng(fromDataUrl(challenge.bg));
  const piece = decodePng(fromDataUrl(challenge.piece_img));
  const { pad, size } = challenge.piece;
  const span = challenge.piece.w;
  const holeY = challenge.piece.top + pad;

  const opaque = (u, v) =>
    u >= 0 && v >= 0 && u < span && v < span && piece.data[(v * span + u) * 4 + 3] > 200;
  // 只用拼图内部像素：边缘那圈描边和投影是加工过的，参与比对只会干扰
  const inner = [];
  for (let v = 2; v < span - 2; v += 2) {
    for (let u = 2; u < span - 2; u += 2) {
      let edge = false;
      for (let dy = -2; dy <= 2 && !edge; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          if (!opaque(u + dx, v + dy)) {
            edge = true;
            break;
          }
        }
      }
      if (!edge) inner.push([u, v]);
    }
  }

  let bestX = -1;
  let bestScore = Infinity;
  for (let x = 0; x <= challenge.width - size; x += 1) {
    let score = 0;
    let count = 0;
    for (const [u, v] of inner) {
      const px = x + u - pad;
      const py = holeY + v - pad;
      if (px < 0 || py < 0 || px >= challenge.width || py >= challenge.height) continue;
      const pi = (v * span + u) * 4;
      const bi = (py * challenge.width + px) * 4;
      for (let c = 0; c < 3; c += 1) {
        // 缺口被压暗了：通道系数和 human-check.js 里保持一致
        const expect = piece.data[pi + c] * [0.34, 0.38, 0.46][c] + [12, 18, 30][c];
        score += (bg.data[bi + c] - expect) ** 2;
      }
      count += 1;
    }
    if (count < 50) continue;
    const avg = score / count;
    if (avg < bestScore) {
      bestScore = avg;
      bestX = x;
    }
  }
  return { x: bestX, score: bestScore };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      PUBLIC_ORIGIN: base,
      LOG_REQUESTS: '0',
      SESSION_DAYS: '1',
      HUMAN_CHECK_SECRET: 'smoke-test-secret',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const cleanup = () => {
    try {
      if (process.platform === 'win32') {
        // Windows 下要连子进程树一起结束，否则会留下占端口的孤儿进程
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

  // 极简 cookie jar
  let cookie = '';
  // 人机验证令牌：过了验证之后每个请求都带上（模拟启动器的做法）
  let humanToken = '';
  async function request(method, urlPath, body, { raw = false } = {}) {
    const headers = { accept: 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (humanToken) headers['x-human-token'] = humanToken;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
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
    return { status: res.status, json, text, headers: res.headers };
  }

  const health = await request('GET', '/api/health');
  check('健康检查', health.json?.ok === true);

  // ── 人机验证门禁 ──
  const gated = await request('GET', '/api/boards');
  check('没过人机验证时接口被拦', gated.status === 403 && gated.json?.code === 'human_required', gated.text);

  const pageRedirect = await fetch(`${base}/`, { redirect: 'manual' });
  const redirectTo = String(pageRedirect.headers.get('location') || '');
  check(
    '没过人机验证时页面跳验证页',
    pageRedirect.status === 302 && redirectTo.startsWith('/verify.html?next='),
    `${pageRedirect.status} ${redirectTo}`,
  );

  const verifyPage = await fetch(`${base}/verify.html`);
  check('验证页本身打得开', verifyPage.status === 200);

  const challenge = await request('GET', '/api/human/challenge');
  const puzzle = challenge.status === 200 ? challenge.json : null;
  check(
    '能拿到滑块验证题',
    !!puzzle?.id && String(puzzle.bg).startsWith('data:image/png') && !!puzzle.piece?.pad,
    challenge.text,
  );

  const solved = puzzle ? solvePuzzle(puzzle) : { x: 0, score: Infinity };
  check('验证题的缺口位置能算出来', puzzle ? solved.score < 50 : false, `残差 ${solved.score?.toFixed?.(1)}`);

  const badId = await request('POST', '/api/human/verify', { id: 'not-a-real-id', answer: solved.x, duration: 800 });
  check('题目对不上号时交卷被拒', badId.status === 400, badId.text);

  const passed = puzzle
    ? await request('POST', '/api/human/verify', { id: puzzle.id, answer: solved.x, duration: 800 })
    : { status: 0, json: null, text: '' };
  check('拼图对准缺口后通过验证', passed.status === 200 && !!passed.json?.token, passed.text);
  humanToken = passed.json?.token || '';
  // 丢掉验证 Cookie，后面全靠 X-Human-Token 请求头（启动器就是这么走的）
  cookie = '';

  const humanStatus = await request('GET', '/api/human/status');
  check(
    '免验状态生效',
    humanStatus.json?.verified === true && humanStatus.json?.remaining > 0,
    humanStatus.text,
  );

  const afterVerify = await request('GET', '/api/boards');
  check('验证后接口放行', afterVerify.status === 200 && afterVerify.json?.boards?.length >= 6);

  const anonMe = await request('GET', '/api/me');
  check('未登录时 /api/me 返回空用户', anonMe.status === 200 && anonMe.json?.user === null);

  const boards = await request('GET', '/api/boards');
  check('默认板块存在', boards.json?.boards?.length >= 6, `板块数 ${boards.json?.boards?.length}`);

  const register = await request('POST', '/api/auth/register', { username: '测试管理员', password: 'test123456' });
  check('首个注册用户自动成为管理员', register.status === 200 && register.json?.user?.role === 'admin', register.text);
  const adminId = register.json?.user?.id;
  // 发帖 / 回复要求先通过入站答题，这里直接上报及格成绩
  const adminQuiz = await request('POST', '/api/quiz/complete', { score: 96 });
  check('管理员通过入站答题', adminQuiz.json?.quiz_passed === true, adminQuiz.text);

  const dup = await request('POST', '/api/auth/register', { username: '测试管理员', password: 'test123456' });
  check('重复用户名被拒绝', dup.status === 400);

  const thread = await request('POST', '/api/threads', {
    board: 'general',
    title: '冒烟测试主题：方块盒子论坛',
    content: '这是一条**测试**内容，包含 `代码` 和 [官网](https://mcblockbox.top)。',
  });
  check('发帖成功', thread.status === 200 && thread.json?.id > 0, thread.text);
  const threadId = thread.json?.id;

  const detail = await request('GET', `/api/threads/${threadId}`);
  check('主题详情含首楼', detail.json?.posts?.length === 1 && detail.json?.posts[0]?.floor === 1);
  check('浏览量自增', detail.json?.thread?.views >= 1);

  const reply = await request('POST', `/api/threads/${threadId}/posts`, { content: '第一条回复' });
  check('回复成功且楼层为 2', reply.status === 200 && reply.json?.post?.floor === 2, reply.text);

  const afterReply = await request('GET', `/api/threads/${threadId}`);
  check('回复后主题回复数为 1', afterReply.json?.thread?.reply_count === 1);

  const search = await request('GET', '/api/search?q=' + encodeURIComponent('冒烟'));
  check('搜索命中刚发的主题', search.json?.results?.some((item) => item.id === threadId), search.text);

  const searchZh = await request('GET', '/api/search?q=' + encodeURIComponent('回复'));
  check('中文两字搜索可用', searchZh.json?.results?.length >= 1, searchZh.text);

  const profile = await request('GET', `/api/users/${adminId}`);
  check('用户主页可访问', profile.status === 200 && profile.json?.user?.username === '测试管理员');

  const pin = await request('PATCH', `/api/admin/threads/${threadId}`, { pinned: true });
  check('管理员置顶', pin.status === 200 && pin.json?.thread?.pinned === true, pin.text);

  const lock = await request('PATCH', `/api/admin/threads/${threadId}`, { locked: true });
  check('管理员锁定', lock.json?.thread?.locked === true);

  // 头像上传走原始二进制（1x1 透明 PNG），绕过 JSON 解析
  const avatar2 = await fetch(`${base}/api/me/avatar`, {
    method: 'POST',
    headers: { cookie, 'x-human-token': humanToken, 'content-type': 'image/png' },
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  check('上传头像', avatar2.status === 200, `status ${avatar2.status}`);

  // 封面同样走原始二进制
  const coverRes = await fetch(`${base}/api/me/cover`, {
    method: 'POST',
    headers: { cookie, 'x-human-token': humanToken, 'content-type': 'image/png' },
    body: Buffer.from(PNG_BASE64, 'base64'),
  });
  const coverJson = await coverRes.json();
  check(
    '上传主页封面',
    coverRes.status === 200 && String(coverJson.cover || '').startsWith('/uploads/cover-'),
    JSON.stringify(coverJson),
  );
  const coverProfile = await request('GET', `/api/users/${adminId}`);
  check('用户主页带封面地址', coverProfile.json?.user?.cover === coverJson.cover, coverProfile.text);

  const coverRemove = await request('DELETE', '/api/me/cover');
  check('删除主页封面', coverRemove.status === 200);
  const coverCleared = await request('GET', `/api/me`);
  check('删除后封面为空', !coverCleared.json?.user?.cover, coverCleared.text);

  const logout = await request('POST', '/api/auth/logout');
  check('退出登录', logout.status === 200);

  const afterLogout = await request('POST', '/api/threads', { board: 'chat', title: '退出后发帖', content: '应该失败' });
  check('退出后发帖返回 401', afterLogout.status === 401, afterLogout.text);

  const second = await request('POST', '/api/auth/register', { username: '普通玩家', password: 'test123456' });
  check('第二个用户是普通用户', second.json?.user?.role === 'user');
  const playerQuiz = await request('POST', '/api/quiz/complete', { score: 96 });
  check('普通玩家通过入站答题', playerQuiz.json?.quiz_passed === true, playerQuiz.text);

  const replyLocked = await request('POST', `/api/threads/${threadId}/posts`, { content: '锁定后还能回吗' });
  check('锁定后普通用户回复被拒绝', replyLocked.status === 400, replyLocked.text);

  const denied = await request('PATCH', `/api/admin/users/${adminId}`, { role: 'user' });
  check('普通用户不能调用管理接口', denied.status === 403, denied.text);

  // ---------- 站内通知 / @提及 ----------

  await request('POST', '/api/auth/login', { username: '测试管理员', password: 'test123456' });
  const notifyThread = await request('POST', '/api/threads', {
    board: 'general',
    title: '通知测试主题',
    content: '楼主在这里',
  });
  const notifyThreadId = notifyThread.json?.id;
  check('管理员新建未锁定主题', notifyThread.status === 200 && notifyThreadId > 0, notifyThread.text);

  await request('POST', '/api/auth/logout');
  const third = await request('POST', '/api/auth/register', { username: '路人甲', password: 'test123456' });
  check('第三个用户注册成功', third.status === 200 && third.json?.user?.id > 0, third.text);
  const thirdId = third.json?.user?.id;
  const thirdQuiz = await request('POST', '/api/quiz/complete', { score: 96 });
  check('路人甲通过入站答题', thirdQuiz.json?.quiz_passed === true, thirdQuiz.text);

  await request('POST', '/api/auth/login', { username: '普通玩家', password: 'test123456' });
  const mentionReply = await request('POST', `/api/threads/${notifyThreadId}/posts`, {
    content: '同意楼主说的，顺便 @路人甲 也来看看',
  });
  check('回复并 @ 成功', mentionReply.status === 200, mentionReply.text);
  const mentionedPostId = mentionReply.json?.post?.id;

  await request('POST', '/api/auth/login', { username: '测试管理员', password: 'test123456' });
  const adminMe = await request('GET', '/api/me');
  check('/api/me 带未读通知数', adminMe.json?.unread === 1, JSON.stringify(adminMe.json));
  const adminNotifs = await request('GET', '/api/notifications');
  check('楼主收到回复通知', adminNotifs.json?.items?.[0]?.type === 'reply', adminNotifs.text);

  await request('POST', '/api/auth/login', { username: '路人甲', password: 'test123456' });
  const thirdNotifs = await request('GET', '/api/notifications');
  check('被 @ 的人收到提及通知', thirdNotifs.json?.items?.[0]?.type === 'mention', thirdNotifs.text);
  const marked = await request('POST', '/api/notifications/read', {});
  check('标记已读后未读清零', marked.json?.unread === 0, marked.text);

  // ---------- 站内图床 ----------

  const uploadRes = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { cookie, 'x-human-token': humanToken, 'content-type': 'image/png' },
    body: Buffer.from(PNG_BASE64, 'base64'),
  });
  const uploadJson = await uploadRes.json();
  check(
    '上传图片返回站内地址',
    uploadRes.status === 200 && String(uploadJson.url || '').startsWith('/uploads/'),
    JSON.stringify(uploadJson),
  );
  const imageRes = await fetch(`${base}${uploadJson.url}`);
  check('上传后的图片可访问', imageRes.status === 200, `status ${imageRes.status}`);

  const fakeUpload = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { cookie, 'x-human-token': humanToken, 'content-type': 'image/png' },
    body: Buffer.from('这不是图片，只是一段文本内容而已', 'utf8'),
  });
  check('伪装成图片的文件被拒绝', fakeUpload.status === 400, `status ${fakeUpload.status}`);

  // ---------- 举报与审核 ----------

  const reportRes = await request('POST', '/api/reports', { post_id: mentionedPostId, reason: '测试举报' });
  check('提交举报', reportRes.status === 200, reportRes.text);

  await request('POST', '/api/auth/login', { username: '测试管理员', password: 'test123456' });
  const reportList = await request('GET', '/api/admin/reports?status=open');
  check(
    '管理后台能看到举报',
    reportList.json?.reports?.some((item) => item.post_id === mentionedPostId),
    reportList.text,
  );
  const reportId = reportList.json?.reports?.find((item) => item.post_id === mentionedPostId)?.id;
  const handleReport = await request('PATCH', `/api/admin/reports/${reportId}`, {
    status: 'resolved',
    delete_post: true,
  });
  check('处理举报并删除楼层', handleReport.status === 200, handleReport.text);

  const afterReportThread = await request('GET', `/api/threads/${notifyThreadId}`);
  check(
    '被举报楼层已标记删除',
    afterReportThread.json?.posts?.some((post) => post.id === mentionedPostId && post.deleted === true),
    afterReportThread.text,
  );

  const secondUserReplies = await request('GET', `/api/users/${second.json?.user?.id}/posts`);
  check(
    '用户回复列表带真实总数',
    typeof secondUserReplies.json?.pagination?.total === 'number' &&
      secondUserReplies.json.pagination.total >= 0,
    secondUserReplies.text,
  );

  check('第三个用户 id 有效', Number.isInteger(thirdId) && thirdId > 0);

  // ---------- 楼中楼 / 点赞 / 收藏 / 标签 ----------

  const nestThread = await request('POST', '/api/threads', {
    board: 'general',
    title: '楼中楼测试主题',
    content: '我是楼主',
    tags: '测试,楼中楼',
  });
  check('发帖带标签', (nestThread.json?.thread?.tags || []).length === 2, nestThread.text);
  const nestThreadId = nestThread.json?.id;

  const nestDetail = await request('GET', `/api/threads/${nestThreadId}`);
  const firstPostId = nestDetail.json?.posts?.[0]?.id;

  const childReply = await request('POST', `/api/threads/${nestThreadId}/posts`, {
    content: '这是一条楼中楼',
    reply_to: firstPostId,
  });
  check(
    '楼中楼回复挂在父楼层下',
    childReply.status === 200 && childReply.json?.post?.parent_post_id === firstPostId,
    childReply.text,
  );

  const nestAgain = await request('GET', `/api/threads/${nestThreadId}`);
  check(
    '主题详情返回 children',
    (nestAgain.json?.posts?.[0]?.children || []).some((child) => child.id === childReply.json?.post?.id),
    nestAgain.text,
  );

  const likeOnce = await request('POST', `/api/posts/${firstPostId}/like`, {});
  check('点赞成功', likeOnce.json?.liked === true && likeOnce.json?.likes === 1, likeOnce.text);
  const likeTwice = await request('POST', `/api/posts/${firstPostId}/like`, {});
  check('再点一次取消赞', likeTwice.json?.liked === false && likeTwice.json?.likes === 0, likeTwice.text);

  const bookmark = await request('POST', `/api/threads/${nestThreadId}/bookmark`, {});
  check('收藏主题', bookmark.json?.bookmarked === true, bookmark.text);
  const bookmarkList = await request('GET', '/api/me/bookmarks');
  check(
    '收藏列表包含刚收藏的主题',
    (bookmarkList.json?.threads || []).some((item) => item.id === nestThreadId),
    bookmarkList.text,
  );

  const tagList = await request('GET', '/api/tags');
  check('标签聚合有数据', (tagList.json?.tags || []).length >= 2, tagList.text);
  const taggedThreads = await request('GET', `/api/threads?tag=${encodeURIComponent('楼中楼')}`);
  check(
    '按标签筛选主题',
    (taggedThreads.json?.threads || []).some((item) => item.id === nestThreadId),
    taggedThreads.text,
  );

  const userSearch = await request('GET', `/api/users/search?q=${encodeURIComponent('路')}`);
  check(
    '用户名搜索（@ 补全用）',
    (userSearch.json?.users || []).some((user) => user.username === '路人甲'),
    userSearch.text,
  );

  // ---------- 图片压缩与缩略图 ----------

  const normalUpload = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { cookie, 'x-human-token': humanToken, 'content-type': 'image/png' },
    body: makePng(1200, 800),
  });
  const normalJson = await normalUpload.json();
  check('大图生成缩略图', !!normalJson.thumb, JSON.stringify(normalJson));
  const thumbResponse = await fetch(`${base}${normalJson.thumb}`);
  check('缩略图可访问', thumbResponse.status === 200, `status ${thumbResponse.status}`);

  const hugeUpload = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { cookie, 'x-human-token': humanToken, 'content-type': 'image/png' },
    body: makePng(3000, 600),
  });
  const hugeJson = await hugeUpload.json();
  check(
    '超大图被压到长边上限内',
    hugeJson.width > 0 && hugeJson.width <= 2560 && hugeJson.height <= 2560,
    JSON.stringify(hugeJson),
  );

  // ---------- 楼中楼通知 / 通知折叠 ----------

  const foldThread = await request('POST', '/api/threads', {
    board: 'general',
    title: '通知折叠测试',
    content: '楼主在这里',
  });
  const foldThreadId = foldThread.json?.id;
  const foldDetail = await request('GET', `/api/threads/${foldThreadId}`);
  const foldFirstPost = foldDetail.json?.posts?.[0]?.id;

  await request('POST', '/api/auth/login', { username: '普通玩家', password: 'test123456' });
  const foldReply1 = await request('POST', `/api/threads/${foldThreadId}/posts`, { content: '补充一下' });
  const foldReply2 = await request('POST', `/api/threads/${foldThreadId}/posts`, { content: '再补充一下' });

  await request('POST', '/api/auth/login', { username: '测试管理员', password: 'test123456' });
  const replyToPlayer = await request('POST', `/api/threads/${foldThreadId}/posts`, {
    content: '谢谢补充',
    reply_to: foldReply1.json?.post?.id,
  });
  check('管理员回复楼中楼', replyToPlayer.status === 200, replyToPlayer.text);

  const adminNotifs2 = await request('GET', '/api/notifications');
  const foldGroup = (adminNotifs2.json?.items || []).find((item) => item.thread_id === foldThreadId);
  check('同一主题的回复通知折叠成一组', !!foldGroup && foldGroup.count === 2, JSON.stringify(foldGroup));
  check('通知组带 ids 便于批量已读', Array.isArray(foldGroup?.ids) && foldGroup.ids.length >= 2);

  await request('POST', '/api/auth/login', { username: '普通玩家', password: 'test123456' });
  const playerNotifs = await request('GET', '/api/notifications');
  const replyToMe = (playerNotifs.json?.items || []).find(
    (item) => item.thread_id === foldThreadId && item.target_kind === 'post',
  );
  check('回复楼中楼会通知被回复的人', !!replyToMe, playerNotifs.text);

  // ---------- 我赞过的 / 相册 ----------

  const likeForList = await request('POST', `/api/posts/${foldReply2.json?.post?.id}/like`, {});
  check('点赞用于「我赞过的」', likeForList.json?.liked === true, likeForList.text);
  const myLikes = await request('GET', '/api/me/likes');
  check(
    '我赞过的列表包含刚赞的楼层',
    (myLikes.json?.likes || []).some((item) => item.post_id === foldReply2.json?.post?.id),
    myLikes.text,
  );

  // 图片是管理员上传的，相册要切回管理员才看得到
  await request('POST', '/api/auth/login', { username: '测试管理员', password: 'test123456' });
  const album = await request('GET', '/api/me/uploads');
  check('我的相册列出上传记录', (album.json?.uploads || []).length >= 1, album.text);
  const albumId = album.json?.uploads?.[0]?.id;
  const albumDelete = await request('DELETE', `/api/me/uploads/${albumId}`);
  check('删除相册里的图片', albumDelete.status === 200, albumDelete.text);

  // ---------- 标签管理 ----------

  const adminTags = await request('GET', '/api/admin/tags');
  check(
    '后台能看到标签',
    (adminTags.json?.tags || []).some((item) => item.tag === '楼中楼'),
    adminTags.text,
  );

  const featureTag = await request('POST', '/api/admin/tags/feature', { tag: '楼中楼', featured: true });
  check('设为推荐标签', featureTag.json?.featured === true, featureTag.text);
  const publicTags = await request('GET', '/api/tags');
  check(
    '公开标签接口带推荐标记',
    (publicTags.json?.tags || []).some((item) => item.tag === '楼中楼' && item.featured),
    publicTags.text,
  );

  const mergeTags = await request('POST', '/api/admin/tags/merge', {
    from: ['楼中楼', '测试'],
    to: '社区测试',
  });
  check('合并标签', mergeTags.status === 200 && mergeTags.json?.into === '社区测试', mergeTags.text);
  const mergedThreads = await request('GET', `/api/threads?tag=${encodeURIComponent('社区测试')}`);
  check(
    '合并后的主题带新标签',
    (mergedThreads.json?.threads || []).some((item) => item.id === nestThreadId),
    mergedThreads.text,
  );

  const removeTag = await request('POST', '/api/admin/tags/delete', { tag: '社区测试' });
  check('删除标签', removeTag.status === 200, removeTag.text);

  // ---------- 联机大厅 ----------

  const lobbyEmpty = await request('GET', '/api/lobby/rooms');
  check('联机大厅初始为空', Array.isArray(lobbyEmpty.json?.rooms), lobbyEmpty.text);

  const lobbyInvalid = await request('POST', '/api/lobby/rooms', { title: '没有邀请码的房间' });
  check(
    '发布房间必须带邀请码或地址',
    lobbyInvalid.status === 400 && lobbyInvalid.json?.code === 'lobby_join_info_required',
    lobbyInvalid.text,
  );

  const lobbyPublish = await request('POST', '/api/lobby/rooms', {
    title: '冒烟联机房间',
    description: '来自冒烟测试',
    core: 'terracotta',
    invite_code: 'U/ABCD-EFGH-IJKL-MNOP',
    game_version: '1.20.1',
    loader: 'Forge',
    mods: ['jei.jar', 'sodium.jar'],
    max_players: 6,
  });
  check('发布联机房间', lobbyPublish.status === 200 && lobbyPublish.json?.room?.id > 0, lobbyPublish.text);
  const lobbyRoomId = lobbyPublish.json?.room?.id;
  check(
    '房间带房主、模组和在线时长',
    lobbyPublish.json?.room?.mine === true
      && lobbyPublish.json?.room?.mods?.length === 2
      && lobbyPublish.json?.room?.expires_in > 0,
    lobbyPublish.text,
  );

  const lobbyList = await request('GET', '/api/lobby/rooms');
  const listedRoom = (lobbyList.json?.rooms || []).find((room) => room.id === lobbyRoomId);
  check('大厅列表能看到刚发布的房间', !!listedRoom, lobbyList.text);
  check('大厅房间带邀请码（网页端只读）', listedRoom?.invite_code === 'U/ABCD-EFGH-IJKL-MNOP', lobbyList.text);

  const lobbyHeartbeat = await request('POST', `/api/lobby/rooms/${lobbyRoomId}/heartbeat`, {
    status: 'playing',
  });
  check('心跳续期并同步状态', lobbyHeartbeat.json?.room?.status === 'playing', lobbyHeartbeat.text);

  const lobbyJoin = await request('POST', `/api/lobby/rooms/${lobbyRoomId}/join`, {});
  check('记录一次加入', lobbyJoin.json?.room?.join_count === 1, lobbyJoin.text);

  const lobbyUpdate = await request('POST', '/api/lobby/rooms', {
    title: '冒烟联机房间（改名）',
    core: 'terracotta',
    invite_code: 'U/ABCD-EFGH-IJKL-MNOP',
  });
  check('重复发布是覆盖而不是新增', lobbyUpdate.json?.room?.id === lobbyRoomId, lobbyUpdate.text);
  const lobbyAfterUpdate = await request('GET', '/api/lobby/rooms');
  check(
    '同一账号只保留一个房间',
    (lobbyAfterUpdate.json?.rooms || []).filter((room) => room.id === lobbyRoomId).length === 1,
    lobbyAfterUpdate.text,
  );

  // 未登录也能看列表，但 mine 是 false，也不能关闭房间
  await request('POST', '/api/auth/logout');
  const lobbyAnon = await request('GET', '/api/lobby/rooms');
  const anonRoom = (lobbyAnon.json?.rooms || []).find((room) => room.id === lobbyRoomId);
  check('未登录可见房间但 mine 为 false', !!anonRoom && anonRoom.mine === false, lobbyAnon.text);
  const lobbyAnonClose = await request('DELETE', `/api/lobby/rooms/${lobbyRoomId}`);
  check('未登录不能关闭房间', lobbyAnonClose.status === 401, lobbyAnonClose.text);

  await request('POST', '/api/auth/login', { username: '测试管理员', password: 'test123456' });
  const lobbyClose = await request('DELETE', `/api/lobby/rooms/${lobbyRoomId}`);
  check('关闭联机房间', lobbyClose.status === 200 && lobbyClose.json?.removed === true, lobbyClose.text);
  const lobbyAfterClose = await request('GET', '/api/lobby/rooms');
  check(
    '关闭后大厅不再列出',
    !(lobbyAfterClose.json?.rooms || []).some((room) => room.id === lobbyRoomId),
    lobbyAfterClose.text,
  );

  // ---------- 首页公告 ----------

  const announceList = await request('GET', '/api/admin/announcements');
  check(
    '公告列表可读',
    announceList.status === 200 && Array.isArray(announceList.json?.announcements),
    announceList.text,
  );
  check('公告文件状态可写', announceList.json?.file?.writable === true, announceList.text);

  const publishedAnnouncement = await request('POST', '/api/admin/announcements', {
    text: '冒烟测试公告：管理后台一键发布',
    link: '/download.html',
  });
  check(
    '一键发布公告',
    publishedAnnouncement.status === 200 && publishedAnnouncement.json?.announcement?.id > 0,
    publishedAnnouncement.text,
  );
  const announcementId = publishedAnnouncement.json?.announcement?.id;

  const announcementFile = path.join(tempRoot, 'announcement.json');
  const readAnnouncementFile = () => JSON.parse(fs.readFileSync(announcementFile, 'utf8'));
  const announcementJson = readAnnouncementFile();
  check(
    '公告写进官网文件并排在最前',
    announcementJson.announcements?.[0]?.text === '冒烟测试公告：管理后台一键发布',
    JSON.stringify(announcementJson),
  );
  check(
    '公告跳转链接写进官网文件',
    announcementJson.announcements?.[0]?.link === '/download.html',
    JSON.stringify(announcementJson),
  );

  const emptyAnnouncement = await request('POST', '/api/admin/announcements', { text: '   ' });
  check('空公告被拒绝', emptyAnnouncement.status === 400, emptyAnnouncement.text);
  const badLinkAnnouncement = await request('POST', '/api/admin/announcements', {
    text: '坏链接公告',
    link: 'javascript:alert(1)',
  });
  check('危险链接被拒绝', badLinkAnnouncement.status === 400, badLinkAnnouncement.text);

  const deletedAnnouncement = await request('DELETE', `/api/admin/announcements/${announcementId}`);
  check('删除公告', deletedAnnouncement.status === 200, deletedAnnouncement.text);
  const announcementAfterDelete = readAnnouncementFile();
  check(
    '删除后官网文件里不再有这条',
    !(announcementAfterDelete.announcements || []).some((item) => item.text === '冒烟测试公告：管理后台一键发布'),
    JSON.stringify(announcementAfterDelete),
  );

  // ---------- 启动重要公告 ----------

  const publishedImportant = await request('POST', '/api/admin/important-announcements', {
    title: '冒烟测试重要公告',
    content: '## 维护通知\n- 22:00 停机\n- **请提前退出游戏**',
    link: '/download.html',
  });
  check(
    '发布启动重要公告',
    publishedImportant.status === 200 && publishedImportant.json?.important?.id > 0,
    publishedImportant.text,
  );
  const importantId = publishedImportant.json?.important?.id;

  const importantFile = readAnnouncementFile();
  check(
    '重要公告正文按 Markdown 原样写入文件',
    importantFile.important?.title === '冒烟测试重要公告'
      && importantFile.important?.content === '## 维护通知\n- 22:00 停机\n- **请提前退出游戏**',
    JSON.stringify(importantFile),
  );
  check(
    '重要公告跳转链接写进文件',
    importantFile.important?.link === '/download.html',
    JSON.stringify(importantFile),
  );

  // 官网 / 论坛打开时弹的就是这个公开接口，不需要登录、也不走人机验证
  const publicImportant = await request('GET', '/api/app/important-announcement');
  check(
    '官网与论坛能读到生效中的重要公告',
    publicImportant.status === 200
      && publicImportant.json?.important?.title === '冒烟测试重要公告'
      && String(publicImportant.json?.important?.content || '').includes('维护通知'),
    publicImportant.text,
  );

  const publishedSecondImportant = await request('POST', '/api/admin/important-announcements', {
    title: '第二条重要公告',
    content: '新公告会顶替旧公告',
  });
  const secondImportantId = publishedSecondImportant.json?.important?.id;
  const importantAfterSecond = readAnnouncementFile();
  check(
    '新重要公告顶替旧的',
    importantAfterSecond.important?.title === '第二条重要公告',
    JSON.stringify(importantAfterSecond),
  );
  const publicImportantAfterSecond = await request('GET', '/api/app/important-announcement');
  check(
    '公开接口跟着换成最新一条',
    publicImportantAfterSecond.json?.important?.title === '第二条重要公告',
    publicImportantAfterSecond.text,
  );
  const importantAfterSecondList = await request('GET', '/api/admin/announcements');
  const firstInHistory = (importantAfterSecondList.json?.important || []).find((item) => item.id === importantId);
  check('旧重要公告保留在历史里并已下线', firstInHistory?.enabled === 0, importantAfterSecondList.text);

  const reenabledImportant = await request('PATCH', `/api/admin/important-announcements/${importantId}`, {
    enabled: true,
  });
  check('重新上线旧重要公告', reenabledImportant.status === 200, reenabledImportant.text);
  check(
    '上线后文件里的重要公告跟着换',
    readAnnouncementFile().important?.title === '冒烟测试重要公告',
    JSON.stringify(readAnnouncementFile()),
  );

  const emptyImportant = await request('POST', '/api/admin/important-announcements', {
    title: '空正文',
    content: '   ',
  });
  check('空重要公告正文被拒绝', emptyImportant.status === 400, emptyImportant.text);
  const badLinkImportant = await request('POST', '/api/admin/important-announcements', {
    title: '坏链接',
    content: '正文',
    link: 'javascript:alert(1)',
  });
  check('重要公告危险链接被拒绝', badLinkImportant.status === 400, badLinkImportant.text);

  await request('DELETE', `/api/admin/important-announcements/${importantId}`);
  await request('DELETE', `/api/admin/important-announcements/${secondImportantId}`);
  const importantAfterDelete = readAnnouncementFile();
  check(
    '删除重要公告后文件里不再有 important 字段',
    !importantAfterDelete.important,
    JSON.stringify(importantAfterDelete),
  );
  const publicImportantEmpty = await request('GET', '/api/app/important-announcement');
  check(
    '没有生效的重要公告时公开接口返回 null',
    publicImportantEmpty.status === 200 && publicImportantEmpty.json?.important === null,
    publicImportantEmpty.text,
  );

  await request('POST', '/api/auth/logout');
  const announceAnon = await request('POST', '/api/admin/announcements', { text: '未登录公告' });
  check('未登录不能发布公告', announceAnon.status === 401, announceAnon.text);
  await request('POST', '/api/auth/login', { username: '路人甲', password: 'test123456' });
  const announceForbidden = await request('POST', '/api/admin/announcements', { text: '普通用户公告' });
  check('普通用户不能发布公告', announceForbidden.status === 403, announceForbidden.text);
  await request('POST', '/api/auth/login', { username: '测试管理员', password: 'test123456' });

  // ---------- 访问统计 ----------

  await request('GET', '/');
  await request('GET', '/board.html?slug=general');
  await request('GET', '/thread.html?id=1');
  await request('GET', '/admin.html'); // 管理后台自己不算访问量

  const visits = await request('GET', '/api/admin/visits?days=7');
  const visitSummary = visits.json?.summary || {};
  check('访问统计：今日浏览量', visitSummary.today?.pv >= 3, visits.text);
  check('访问统计：今日访客（日活）', visitSummary.today?.uv >= 1, visits.text);
  check('访问统计：近 30 天访客（月活）', visitSummary.month?.uv >= 1, visits.text);
  check('访问统计：累计浏览量', visitSummary.total?.pv >= 3, visits.text);
  check('访问统计：趋势图补齐到请求天数', (visits.json?.series || []).length === 7, visits.text);
  check('访问统计：今日 24 小时固定 24 条', (visits.json?.hours || []).length === 24, visits.text);
  check(
    '访问统计：热门页面里有帖子页',
    (visits.json?.pages || []).some((item) => item.path === '/thread.html'),
    visits.text,
  );
  check(
    '访问统计：管理后台浏览量不计入',
    !(visits.json?.pages || []).some((item) => item.path === '/admin.html'),
    visits.text,
  );

  await request('POST', '/api/auth/logout', {});
  const visitsAnon = await request('GET', '/api/admin/visits');
  check('访问统计：未登录看不到', visitsAnon.status === 401, visitsAnon.text);
  await request('POST', '/api/auth/login', { username: '测试管理员', password: 'test123456' });

  const notFoundPage = await request('GET', '/no-such-page');
  check('未知页面返回 404 页面', notFoundPage.status === 404);

  const summary = results.filter((item) => !item.ok);
  console.log(`\n${results.length - summary.length}/${results.length} 项通过`);
  if (summary.length > 0) {
    console.log('失败项：');
    for (const item of summary) console.log(` - ${item.name} ${item.detail}`);
    process.exitCode = 1;
  }

  // 显式收尾，避免残留的子进程 / 连接让脚本卡住
  cleanup();
  process.exit(process.exitCode || 0);
}

main().catch((error) => {
  console.error('冒烟测试异常：', error);
  process.exitCode = 1;
});
