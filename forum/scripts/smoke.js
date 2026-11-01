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

import { encodePng } from '../server/lib/png.js';

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
      PUBLIC_ORIGIN: base,
      LOG_REQUESTS: '0',
      SESSION_DAYS: '1',
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
  async function request(method, urlPath, body, { raw = false } = {}) {
    const headers = { accept: 'application/json' };
    if (cookie) headers.cookie = cookie;
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

  const anonMe = await request('GET', '/api/me');
  check('未登录时 /api/me 返回空用户', anonMe.status === 200 && anonMe.json?.user === null);

  const boards = await request('GET', '/api/boards');
  check('默认板块存在', boards.json?.boards?.length >= 6, `板块数 ${boards.json?.boards?.length}`);

  const register = await request('POST', '/api/auth/register', { username: '测试管理员', password: 'test123456' });
  check('首个注册用户自动成为管理员', register.status === 200 && register.json?.user?.role === 'admin', register.text);
  const adminId = register.json?.user?.id;

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
    headers: { cookie, 'content-type': 'image/png' },
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  check('上传头像', avatar2.status === 200, `status ${avatar2.status}`);

  // 封面同样走原始二进制
  const coverRes = await fetch(`${base}/api/me/cover`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'image/png' },
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
    headers: { cookie, 'content-type': 'image/png' },
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
    headers: { cookie, 'content-type': 'image/png' },
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
    headers: { cookie, 'content-type': 'image/png' },
    body: makePng(1200, 800),
  });
  const normalJson = await normalUpload.json();
  check('大图生成缩略图', !!normalJson.thumb, JSON.stringify(normalJson));
  const thumbResponse = await fetch(`${base}${normalJson.thumb}`);
  check('缩略图可访问', thumbResponse.status === 200, `status ${thumbResponse.status}`);

  const hugeUpload = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'image/png' },
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
