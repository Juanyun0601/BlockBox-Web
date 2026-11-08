import { db, now } from '../db.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { muteError, requireUser } from '../lib/auth.js';
import { enforce } from '../lib/rate-limit.js';
import {
  DM_SELECT,
  acceptedBetween,
  dmOut,
  friendshipBetween,
  incomingRequestCount,
  listFriends,
  listRequests,
  peerOut,
  unreadTotal,
} from '../lib/social.js';
import { GM_SELECT, groupMessageOut, isGroupMember, listGroups } from '../lib/groups.js';
import { ensureSupportFriend, isSupportUser } from '../lib/support.js';
import { ensureOfficialGroupMember } from '../lib/official-group.js';
import { int, text, username } from '../lib/validate.js';
import {
  chatFileDisplayName,
  consumeQuota,
  findOwnChatFile,
  sanitizeFileName,
  weeklyUsage,
} from '../lib/chat-files.js';
import { config } from '../config.js';

export default function register(router) {
  // ---------------- 好友 ----------------

  /** 好友页一次拉全：好友（带未读/最后一条）、收到的申请、发出的申请 */
  router.get('/api/friends', async (ctx) => {
    const user = requireUser(ctx.user);
    // 官方客服是默认好友：老账号补一次关系，玩家删过也会自动恢复
    ensureSupportFriend(user.id);
    // 官方全用户群是默认群聊：不在群里（或群重建过）就自动回来
    ensureOfficialGroupMember(user.id);
    return {
      friends: listFriends(user.id),
      incoming: listRequests(user.id, 'incoming'),
      outgoing: listRequests(user.id, 'outgoing'),
      groups: listGroups(user.id),
      total_unread: unreadTotal(user.id),
    };
  });

  /** 发好友申请：user_id 或 username 二选一；对方已先申请我时直接成为好友 */
  router.post('/api/friends/requests', async (ctx) => {
    const user = requireUser(ctx.user);
    const body = await ctx.json();

    let target = null;
    if (body.user_id !== undefined && body.user_id !== null && body.user_id !== '') {
      const id = int(body.user_id, { field: '用户' });
      target = db.prepare('SELECT id, username, display_name, avatar, status FROM users WHERE id = ?').get(id);
    } else {
      const name = username(body.username);
      target = db
        .prepare('SELECT id, username, display_name, avatar, status FROM users WHERE username = ? COLLATE NOCASE')
        .get(name);
    }
    if (!target) throw notFound('用户不存在');
    if (target.id === user.id) throw badRequest('不能加自己为好友');
    if (target.status === 'banned') throw notFound('用户不存在');

    const existing = friendshipBetween(user.id, target.id);
    if (existing) {
      if (existing.status === 'accepted') return { ok: true, status: 'friends' };
      if (existing.requester_id === user.id) return { ok: true, status: 'outgoing' };
      // 对方之前先申请了我：直接通过，省一来一回
      db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?").run(now(), existing.id);
      return { ok: true, status: 'friends' };
    }

    enforce(`friend-req:${user.id}`, 20, 60 * 60 * 1000, '好友申请发得太频繁');
    const timestamp = now();
    db.prepare(
      `INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?)`,
    ).run(user.id, target.id, timestamp, timestamp);
    return { ok: true, status: 'pending', user: peerOut(target) };
  });

  /** 申请行公共校验：存在且还是 pending */
  function pendingRequest(rawId) {
    const row = db.prepare('SELECT * FROM friendships WHERE id = ?').get(Number(rawId));
    if (!row) throw notFound('申请不存在或已被处理');
    if (row.status !== 'pending') throw badRequest('该申请已经处理过了');
    return row;
  }

  router.post('/api/friends/requests/:id/accept', async (ctx) => {
    const user = requireUser(ctx.user);
    const row = pendingRequest(ctx.params.id);
    if (row.addressee_id !== user.id) throw forbidden('只有发给你的申请才能通过');
    db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?").run(now(), row.id);
    return { ok: true, status: 'friends', user_id: row.requester_id };
  });

  router.post('/api/friends/requests/:id/decline', async (ctx) => {
    const user = requireUser(ctx.user);
    const row = pendingRequest(ctx.params.id);
    if (row.addressee_id !== user.id) throw forbidden('只有发给你的申请才能拒绝');
    db.prepare('DELETE FROM friendships WHERE id = ?').run(row.id);
    return { ok: true };
  });

  /** 撤回自己发出的申请 */
  router.delete('/api/friends/requests/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const row = pendingRequest(ctx.params.id);
    if (row.requester_id !== user.id) throw forbidden('只能撤回自己发出的申请');
    db.prepare('DELETE FROM friendships WHERE id = ?').run(row.id);
    return { ok: true };
  });

  /** 删除好友（官方客服是默认好友，不能删除） */
  router.delete('/api/friends/:userId', async (ctx) => {
    const user = requireUser(ctx.user);
    const peerId = int(ctx.params.userId, { field: '用户' });
    if (isSupportUser(peerId)) throw badRequest('官方客服是默认好友，不能删除');
    const rel = friendshipBetween(user.id, peerId);
    if (!rel || rel.status !== 'accepted') throw notFound('你们还不是好友');
    db.prepare('DELETE FROM friendships WHERE id = ?').run(rel.id);
    return { ok: true };
  });

  // ---------------- 私信 ----------------
  // 注意：/api/messages/poll 必须注册在 /api/messages/:userId 之前，
  // 否则 "poll" 会被当成用户 id。

  /**
   * 轻量轮询：角标（未读私信 + 待处理申请）、会话列表增量、当前聊天的新消息。
   * 刻意不标记已读——已读只发生在真正打开会话的 GET /api/messages/:userId 上。
   */
  router.get('/api/messages/poll', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`dm-poll:${user.id}`, 240, 60 * 1000, '刷新太频繁');
    const peerId = int(ctx.url.searchParams.get('peer_id'), { field: 'peer_id', fallback: 0 });
    const afterId = int(ctx.url.searchParams.get('after_id'), { field: 'after_id', fallback: 0 });
    const groupId = int(ctx.url.searchParams.get('group_id'), { field: 'group_id', fallback: 0 });
    const groupAfterId = int(ctx.url.searchParams.get('group_after_id'), { field: 'group_after_id', fallback: 0 });

    let messages = [];
    if (peerId > 0 && afterId >= 0 && acceptedBetween(user.id, peerId)) {
      const rows = db
        .prepare(
          `${DM_SELECT}
            WHERE ((m.sender_id = ? AND m.peer_id = ?) OR (m.sender_id = ? AND m.peer_id = ?)) AND m.id > ?
            ORDER BY m.id ASC
            LIMIT 50`,
        )
        .all(user.id, peerId, peerId, user.id, afterId);
      messages = rows.map((row) => dmOut(row, user.id));
    }

    // 当前打开的群会话的新消息（是成员才拉；群解散后 isGroupMember 自然为 false）
    let groupMessages = [];
    if (groupId > 0 && groupAfterId >= 0 && isGroupMember(groupId, user.id)) {
      const rows = db
        .prepare(`${GM_SELECT} WHERE m.group_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT 50`)
        .all(groupId, groupAfterId);
      groupMessages = rows.map((row) => groupMessageOut(row, user.id));
    }

    return {
      total_unread: unreadTotal(user.id),
      incoming_requests: incomingRequestCount(user.id),
      friends: listFriends(user.id),
      groups: listGroups(user.id),
      messages,
      group_messages: groupMessages,
    };
  });

  function requireFriend(me, peerId) {
    const peer = db.prepare('SELECT * FROM users WHERE id = ?').get(peerId);
    if (!peer || peer.status === 'banned') throw notFound('用户不存在');
    if (!acceptedBetween(me.id, peerId)) throw forbidden('先加为好友才能私信');
    return peer;
  }

  /** 打开会话：标记已读 + 拉一页历史（升序，before_id 往前翻更早的） */
  router.get('/api/messages/:userId', async (ctx) => {
    const user = requireUser(ctx.user);
    const peerId = int(ctx.params.userId, { field: '用户' });
    const peer = requireFriend(user, peerId);

    db.prepare('UPDATE direct_messages SET read_at = ? WHERE sender_id = ? AND peer_id = ? AND read_at = 0').run(
      now(),
      peerId,
      user.id,
    );

    const beforeId = int(ctx.url.searchParams.get('before_id'), { field: 'before_id', fallback: 0 });
    const limit = Math.min(100, Math.max(1, int(ctx.url.searchParams.get('limit'), { field: 'limit', fallback: 40 })));
    const params = [user.id, peerId, peerId, user.id];
    let where = '';
    if (beforeId > 0) {
      where = 'AND m.id < ?';
      params.push(beforeId);
    }
    const rows = db
      .prepare(
        `${DM_SELECT}
          WHERE (m.sender_id = ? AND m.peer_id = ?) OR (m.sender_id = ? AND m.peer_id = ?) ${where}
          ORDER BY m.id DESC
          LIMIT ?`,
      )
      .all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map((row) => dmOut(row, user.id));
    return { user: peerOut(peer), messages, has_more: hasMore };
  });

  router.post('/api/messages/:userId', async (ctx) => {
    const user = requireUser(ctx.user);
    // 禁言里勾了「私信」就不让发
    const mute = muteError(user, 'dm');
    if (mute) throw mute;
    enforce(`dm:${user.id}`, 30, 60 * 1000, '私信发得太频繁');
    const peerId = int(ctx.params.userId, { field: '用户' });
    requireFriend(user, peerId);

    const body = await ctx.json();
    const kind = body.kind === 'image' ? 'image' : body.kind === 'file' ? 'file' : 'text';
    let content = '';
    let image = '';
    let fileUrl = '';
    let fileName = '';
    let fileSize = 0;
    if (kind === 'image') {
      // 图片走 /api/upload 拿到的站内地址
      image = String(body.image || '');
      if (!image.startsWith('/uploads/') || image.length > 200 || image.includes('..')) {
        throw badRequest('图片地址无效');
      }
      if (body.body !== undefined && body.body !== null && body.body !== '') {
        content = text(body.body, { field: '附言', max: 200 });
      }
    } else if (kind === 'file') {
      // 文件走 /api/upload/chat 拿到的站内地址；大小以服务端登记的为准
      const uploaded = findOwnChatFile(String(body.file_url || ''), user.id);
      if (!uploaded) throw badRequest('文件还没上传成功，请重新发送');
      fileUrl = uploaded.url;
      fileSize = uploaded.size;
      fileName = sanitizeFileName(body.file_name) || chatFileDisplayName(uploaded) || '文件';
      if (body.body !== undefined && body.body !== null && body.body !== '') {
        content = text(body.body, { field: '附言', max: 200 });
      }
    } else {
      content = text(body.body, { field: '私信内容', min: 1, max: 1000 });
    }

    // 回复引用：只能引用这个会话里的消息
    let replyTo = 0;
    if (body.reply_to !== undefined && body.reply_to !== null && body.reply_to !== '') {
      replyTo = int(body.reply_to, { field: '回复消息' });
      const target = db.prepare('SELECT sender_id, peer_id FROM direct_messages WHERE id = ?').get(replyTo);
      const inPair =
        target &&
        ((target.sender_id === user.id && target.peer_id === peerId) ||
          (target.sender_id === peerId && target.peer_id === user.id));
      if (!inPair) throw notFound('要回复的消息不存在');
    }

    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO direct_messages (sender_id, peer_id, body, kind, image, file_url, file_name, file_size, reply_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(user.id, peerId, content, kind, image, fileUrl, fileName, fileSize, replyTo, timestamp);
    const row = db.prepare(`${DM_SELECT} WHERE m.id = ?`).get(Number(result.lastInsertRowid));
    return { message: dmOut(row, user.id) };
  });

  /** 撤回自己 10 分钟内发出的消息：内容清空，双方都显示「撤回了一条消息」 */
  router.delete('/api/messages/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const id = int(ctx.params.id, { field: '消息' });
    const row = db.prepare('SELECT * FROM direct_messages WHERE id = ?').get(id);
    if (!row) throw notFound('消息不存在或已被撤回');
    if (row.sender_id !== user.id) throw forbidden('只能撤回自己发的消息');
    if (row.kind === 'withdrawn') throw badRequest('这条消息已经撤回过了');
    if (now() - row.created_at > 10 * 60) throw badRequest('超过 10 分钟的消息不能撤回了');
    db.prepare(
      `UPDATE direct_messages SET kind = 'withdrawn', body = '', image = '', file_url = '', file_name = '', file_size = 0, reply_to = 0 WHERE id = ?`,
    ).run(id);
    return { ok: true };
  });

  // ---------------- 聊天文件提取与流量 ----------------

  /**
   * 提取（下载）一条私聊文件：校验会话双方 → 扣本周流量（下载自己发的不扣）→
   * 返回站内下载地址。私聊永远不走 CDN，客户端直接向论坛服务器取文件。
   */
  router.post('/api/messages/file/:id/extract', async (ctx) => {
    const user = requireUser(ctx.user);
    const id = int(ctx.params.id, { field: '消息' });
    const row = db.prepare('SELECT * FROM direct_messages WHERE id = ?').get(id);
    if (!row || row.kind !== 'file' || !row.file_url) throw notFound('文件不存在或已被撤回');
    if (row.sender_id !== user.id && row.peer_id !== user.id) throw forbidden('只能提取你们会话里的文件');

    const result = consumeQuota(user.id, row.file_size, { isOwn: row.sender_id === user.id });
    if (!result.ok) {
      throw forbidden('本周 30MB 下载流量已用完，下周一自动重置', 'chat_quota_exhausted');
    }
    return { url: row.file_url, name: row.file_name, size: row.file_size, remaining: result.remaining };
  });

  /** 我本周的聊天文件下载流量（客户端在界面上提示剩余额度用） */
  router.get('/api/chat/quota', async (ctx) => {
    const user = requireUser(ctx.user);
    const used = weeklyUsage(user.id);
    const limit = config.chatWeeklyQuotaBytes;
    return { used, limit, remaining: Math.max(0, limit - used) };
  });
}
