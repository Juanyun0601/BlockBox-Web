import { db, now, transaction } from '../db.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { muteError, requireUser } from '../lib/auth.js';
import { enforce } from '../lib/rate-limit.js';
import { int, text } from '../lib/validate.js';
import { acceptedBetween } from '../lib/social.js';
import { chatFileDisplayName, consumeQuota, findOwnChatFile, sanitizeFileName } from '../lib/chat-files.js';
import { config } from '../config.js';
import {
  MAX_GROUP_INVITEES,
  GM_SELECT,
  groupMessageOut,
  groupOut,
  isGroupMember,
  touchGroupRead,
} from '../lib/groups.js';
import { isOfficialGroup } from '../lib/official-group.js';

/** 打开群会话时最多返回多少位成员（官方群是全体用户，几万人不能全量下发） */
const MEMBER_LIST_CAP = 100;

export default function register(router) {
  // ---------------- 群聊（基础版） ----------------

  /** 群公共校验：群存在且我还是成员（群解散后行被级联删除，自然落到 notFound） */
  function requireMember(me, groupId) {
    const group = db.prepare('SELECT * FROM chat_groups WHERE id = ?').get(groupId);
    if (!group) throw notFound('群聊不存在或已被解散');
    if (!isGroupMember(group.id, me.id)) throw forbidden('你还不是这个群的成员');
    return group;
  }

  /** 建群：起个名字，从自己的好友里挑人，建群者自动进群 */
  router.post('/api/groups', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`group-create:${user.id}`, 10, 60 * 60 * 1000, '建群太频繁');
    const body = await ctx.json();
    const name = text(body.name, { field: '群名称', min: 1, max: 20 });

    const rawIds = Array.isArray(body.member_ids) ? body.member_ids : [];
    if (rawIds.length === 0) throw badRequest('至少要邀请一位好友');
    if (rawIds.length > MAX_GROUP_INVITEES) throw badRequest(`一次最多邀请 ${MAX_GROUP_INVITEES} 位好友`);

    // 去重、去掉自己，剩下的必须都是已通过的好友（不是好友的悄悄跳过）
    const ids = [...new Set(rawIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))].filter(
      (id) => id !== user.id,
    );
    const memberIds = [];
    for (const id of ids) {
      const target = db.prepare('SELECT id, status FROM users WHERE id = ?').get(id);
      if (!target || target.status === 'banned') continue;
      if (!acceptedBetween(user.id, id)) continue;
      memberIds.push(id);
    }
    if (memberIds.length === 0) throw badRequest('邀请的人里没有你的好友，先把对方加为好友吧');

    const timestamp = now();
    const groupId = transaction(() => {
      const result = db
        .prepare('INSERT INTO chat_groups (name, owner_id, created_at) VALUES (?, ?, ?)')
        .run(name, user.id, timestamp);
      const id = Number(result.lastInsertRowid);
      const insert = db.prepare(
        'INSERT INTO chat_group_members (group_id, user_id, last_read_id, joined_at) VALUES (?, ?, 0, ?)',
      );
      insert.run(id, user.id, timestamp);
      for (const memberId of memberIds) insert.run(id, memberId, timestamp);
      return id;
    });

    const group = db.prepare('SELECT * FROM chat_groups WHERE id = ?').get(groupId);
    const memberCount = memberIds.length + 1;
    return { group: groupOut(group, user.id, { memberCount }) };
  });

  /** 打开群会话：校验成员 + 群信息 + 全量成员 + 拉一页历史（升序），顺手把已读指针推到最新 */
  router.get('/api/groups/:id/messages', async (ctx) => {
    const user = requireUser(ctx.user);
    const groupId = int(ctx.params.id, { field: '群' });
    const group = requireMember(user, groupId);

    const memberRows = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.avatar, u.last_seen_at, r.joined_at
           FROM chat_group_members r JOIN users u ON u.id = r.user_id
          WHERE r.group_id = ? AND u.status != 'banned'
          ORDER BY r.joined_at, u.id
          LIMIT ?`,
      )
      .all(group.id, MEMBER_LIST_CAP);
    const members = memberRows.map((row) => ({
      ...row,
      owner: row.id === group.owner_id,
    }));
    // 成员总数单独数（官方群成员列表被截断时，卡片上的「N 名成员」仍是真实数字）
    const memberCount = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM chat_group_members r JOIN users u ON u.id = r.user_id
          WHERE r.group_id = ? AND u.status != 'banned'`,
      )
      .get(group.id).n;

    const beforeId = int(ctx.url.searchParams.get('before_id'), { field: 'before_id', fallback: 0 });
    const limit = Math.min(100, Math.max(1, int(ctx.url.searchParams.get('limit'), { field: 'limit', fallback: 40 })));
    let where = '';
    const params = [group.id];
    if (beforeId > 0) {
      where = 'AND m.id < ?';
      params.push(beforeId);
    }
    const rows = db
      .prepare(`${GM_SELECT} WHERE m.group_id = ? ${where} ORDER BY m.id DESC LIMIT ?`)
      .all(...params, limit + 1);
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map((row) => groupMessageOut(row, user.id));

    touchGroupRead(group.id, user.id);
    return {
      group: groupOut(group, user.id, { memberCount }),
      members,
      messages,
      has_more: hasMore,
    };
  });

  /** 发群消息：文字 / 图片 / 文件（图片走 /api/upload、文件走 /api/upload/chat 拿到的站内地址），回复只能引用本群消息 */
  router.post('/api/groups/:id/messages', async (ctx) => {
    const user = requireUser(ctx.user);
    // 禁言里勾了「群聊」就不让发
    const mute = muteError(user, 'group');
    if (mute) throw mute;
    enforce(`group-msg:${user.id}`, 30, 60 * 1000, '群消息发得太频繁');
    const groupId = int(ctx.params.id, { field: '群' });
    const group = requireMember(user, groupId);

    const body = await ctx.json();
    const kind = body.kind === 'image' ? 'image' : body.kind === 'file' ? 'file' : 'text';
    let content = '';
    let image = '';
    let fileUrl = '';
    let fileName = '';
    let fileSize = 0;
    if (kind === 'image') {
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
      content = text(body.body, { field: '群消息内容', min: 1, max: 1000 });
    }

    let replyTo = 0;
    if (body.reply_to !== undefined && body.reply_to !== null && body.reply_to !== '') {
      replyTo = int(body.reply_to, { field: '回复消息' });
      const target = db.prepare('SELECT group_id FROM group_messages WHERE id = ?').get(replyTo);
      if (!target || target.group_id !== group.id) throw notFound('要回复的消息不存在');
    }

    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO group_messages (group_id, sender_id, body, kind, image, file_url, file_name, file_size, reply_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(group.id, user.id, content, kind, image, fileUrl, fileName, fileSize, replyTo, timestamp);
    const row = db.prepare(`${GM_SELECT} WHERE m.id = ?`).get(Number(result.lastInsertRowid));
    return { message: groupMessageOut(row, user.id) };
  });

  /** 撤回自己 10 分钟内发出的群消息：内容清空，全体成员都看到「撤回了一条消息」 */
  router.delete('/api/group-messages/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const id = int(ctx.params.id, { field: '消息' });
    const row = db.prepare('SELECT * FROM group_messages WHERE id = ?').get(id);
    if (!row) throw notFound('消息不存在或已被撤回');
    if (!isGroupMember(row.group_id, user.id)) throw forbidden('只能撤回自己发的消息');
    if (row.sender_id !== user.id) throw forbidden('只能撤回自己发的消息');
    if (row.kind === 'withdrawn') throw badRequest('这条消息已经撤回过了');
    if (now() - row.created_at > 10 * 60) throw badRequest('超过 10 分钟的消息不能撤回了');
    db.prepare(
      `UPDATE group_messages SET kind = 'withdrawn', body = '', image = '', file_url = '', file_name = '', file_size = 0, reply_to = 0 WHERE id = ?`,
    ).run(id);
    return { ok: true };
  });

  /**
   * 提取（下载）一条群文件：校验成员资格 → 扣本周流量（下载自己发的不扣）→
   * 返回下载地址。配了 CDN 时给 CDN 完整地址（dl_url），没配退回站内相对路径。
   */
  router.post('/api/groups/files/:id/extract', async (ctx) => {
    const user = requireUser(ctx.user);
    const id = int(ctx.params.id, { field: '消息' });
    const row = db.prepare('SELECT * FROM group_messages WHERE id = ?').get(id);
    if (!row || row.kind !== 'file' || !row.file_url) throw notFound('文件不存在或已被撤回');
    if (!isGroupMember(row.group_id, user.id)) throw forbidden('只有群成员才能提取群文件');

    const result = consumeQuota(user.id, row.file_size, { isOwn: row.sender_id === user.id });
    if (!result.ok) {
      throw forbidden('本周 30MB 下载流量已用完，下周一自动重置', 'chat_quota_exhausted');
    }
    let dlUrl = row.file_url;
    if (config.cdnBase) dlUrl = `${config.cdnBase}${dlUrl}`;
    return { url: row.file_url, dl_url: dlUrl, name: row.file_name, size: row.file_size, remaining: result.remaining };
  });

  /** 退出群聊：普通成员悄悄退；群主退出即解散，所有群消息一并删除 */
  router.delete('/api/groups/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const groupId = int(ctx.params.id, { field: '群' });
    const group = requireMember(user, groupId);
    // 官方全用户群是默认群聊，和官方客服好友一样不能退
    if (isOfficialGroup(group.id)) throw badRequest('官方全用户群不能退出');
    if (group.owner_id === user.id) {
      transaction(() => {
        db.prepare('DELETE FROM chat_groups WHERE id = ?').run(group.id);
      });
      return { ok: true, dissolved: true };
    }
    db.prepare('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?').run(group.id, user.id);
    return { ok: true, dissolved: false };
  });
}
