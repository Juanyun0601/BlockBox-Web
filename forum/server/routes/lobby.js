import { db, now, paginate } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { isAdminRole, requireUser } from '../lib/auth.js';
import { enforce } from '../lib/rate-limit.js';
import { int, text } from '../lib/validate.js';

/**
 * 联机大厅：启动器把本机开好的房间发布到这里，其他人可以在网页端查看邀请码，
 * 或者在方块盒子客户端里一键挑选匹配的实例加入。
 *
 * 房间靠心跳续命：客户端每 40 秒发一次心跳，超过 2 分钟没心跳就认为房间已关闭，
 * 列表接口会把它们直接清掉，避免大厅里堆满过期房间。
 */

const CORE_LABELS = {
  terracotta: '陶瓦联机',
  hongshi: '红石联机',
  frp: '内网穿透',
  custom: '直连',
};

const CORE_KEYS = Object.keys(CORE_LABELS);
const STATUS_KEYS = ['waiting', 'playing', 'full'];
const TTL_SECONDS = 120;

/** 清掉已经久到不可能再有心跳的房间 */
function purgeStale() {
  db.prepare('DELETE FROM lobby_rooms WHERE heartbeat_at < ?').run(now() - TTL_SECONDS);
}

function parseMods(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function roomJson(row, viewer) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    core: row.core,
    core_label: CORE_LABELS[row.core] || row.core,
    invite_code: row.invite_code || '',
    address: row.address || '',
    game_version: row.game_version || '',
    loader: row.loader || '',
    mods: parseMods(row.mods),
    max_players: row.max_players,
    status: row.status,
    join_count: row.join_count || 0,
    host: {
      id: row.owner_id,
      username: row.owner_username || '',
      display_name: row.owner_display_name || row.owner_username || '',
      avatar: row.owner_avatar || '',
    },
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
    expires_in: Math.max(0, Number(row.heartbeat_at || 0) + TTL_SECONDS - now()),
    mine: !!(viewer && viewer.id === row.owner_id),
  };
}

const ROOM_SELECT = `
  SELECT r.*, u.username AS owner_username, u.display_name AS owner_display_name,
         u.avatar AS owner_avatar
    FROM lobby_rooms r
    JOIN users u ON u.id = r.owner_id`;

/** 把发布参数校验成可入库的字段 */
function readPublishBody(body) {
  const title = text(body.title, { field: '房间名', min: 2, max: 40 });
  const description = text(body.description, { field: '房间简介', max: 200, optional: true });
  const core = CORE_KEYS.includes(String(body.core)) ? String(body.core) : 'custom';
  const inviteCode = text(body.invite_code, { field: '邀请码', max: 120, optional: true });
  const address = text(body.address, { field: '连接地址', max: 120, optional: true });
  if (!inviteCode && !address) {
    throw badRequest('请提供邀请码或连接地址', 'lobby_join_info_required');
  }
  const gameVersion = text(body.game_version, { field: '游戏版本', max: 32, optional: true });
  const loader = text(body.loader, { field: '加载器', max: 32, optional: true });

  const mods = [];
  if (Array.isArray(body.mods)) {
    for (const item of body.mods.slice(0, 80)) {
      const name = String(item == null ? '' : item).trim().slice(0, 120);
      if (name && !mods.includes(name)) mods.push(name);
    }
  }

  const maxPlayers = int(body.max_players, { field: '人数上限', min: 1, max: 64, fallback: 8 });
  const status = STATUS_KEYS.includes(String(body.status)) ? String(body.status) : 'waiting';

  return { title, description, core, inviteCode, address, gameVersion, loader, mods, maxPlayers, status };
}

export default function register(router) {
  // ---------------- 房间列表（公开）----------------

  router.get('/api/lobby/rooms', async (ctx) => {
    purgeStale();

    const keyword = String(ctx.url.searchParams.get('q') || '').trim().slice(0, 40);
    const core = String(ctx.url.searchParams.get('core') || '').trim();
    const version = String(ctx.url.searchParams.get('version') || '').trim().slice(0, 32);
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 30, 60);

    const conditions = [];
    const params = [];
    if (keyword) {
      conditions.push('(r.title LIKE ? OR r.description LIKE ? OR u.display_name LIKE ? OR u.username LIKE ?)');
      const like = `%${keyword}%`;
      params.push(like, like, like, like);
    }
    if (CORE_KEYS.includes(core)) {
      conditions.push('r.core = ?');
      params.push(core);
    }
    if (version) {
      conditions.push("r.game_version LIKE ? ESCAPE '\\'");
      const like = `${version.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
      params.push(like);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM lobby_rooms r JOIN users u ON u.id = r.owner_id${where}`)
      .get(...params).n;
    const rows = db
      .prepare(`${ROOM_SELECT}${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`)
      .all(...params, perPage, offset);

    return {
      rooms: rows.map((row) => roomJson(row, ctx.user)),
      total,
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
      server_time: now(),
    };
  });

  // ---------------- 发布 / 更新自己的房间 ----------------

  router.post('/api/lobby/rooms', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`lobby:publish:${user.id}`, 20, 60 * 1000, '发布太频繁，请稍后再试');

    const body = await ctx.json();
    const room = readPublishBody(body);
    const timestamp = now();

    // 同一个账号只保留一个房间：再次发布就是覆盖旧的一条
    const existing = db.prepare('SELECT id FROM lobby_rooms WHERE owner_id = ?').get(user.id);
    let roomId;
    if (existing) {
      db.prepare(
        `UPDATE lobby_rooms
            SET title = ?, description = ?, core = ?, invite_code = ?, address = ?,
                game_version = ?, loader = ?, mods = ?, max_players = ?, status = ?,
                heartbeat_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        room.title,
        room.description,
        room.core,
        room.inviteCode,
        room.address,
        room.gameVersion,
        room.loader,
        JSON.stringify(room.mods),
        room.maxPlayers,
        room.status,
        timestamp,
        timestamp,
        existing.id,
      );
      roomId = existing.id;
    } else {
      const result = db
        .prepare(
          `INSERT INTO lobby_rooms
             (owner_id, title, description, core, invite_code, address, game_version, loader,
              mods, max_players, status, join_count, heartbeat_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          user.id,
          room.title,
          room.description,
          room.core,
          room.inviteCode,
          room.address,
          room.gameVersion,
          room.loader,
          JSON.stringify(room.mods),
          room.maxPlayers,
          room.status,
          timestamp,
          timestamp,
          timestamp,
        );
      roomId = Number(result.lastInsertRowid);
    }

    const row = db.prepare(`${ROOM_SELECT} WHERE r.id = ?`).get(roomId);
    return { room: roomJson(row, user) };
  });

  // ---------------- 心跳续期 ----------------

  router.post('/api/lobby/rooms/:id/heartbeat', async (ctx) => {
    const user = requireUser(ctx.user);
    const row = db.prepare('SELECT * FROM lobby_rooms WHERE id = ?').get(Number(ctx.params.id));
    if (!row || row.owner_id !== user.id) {
      throw notFound('房间已过期，请重新发布', 'lobby_room_gone');
    }

    const body = await ctx.json();
    const status = STATUS_KEYS.includes(String(body.status)) ? String(body.status) : row.status;
    const timestamp = now();
    db.prepare('UPDATE lobby_rooms SET heartbeat_at = ?, status = ?, updated_at = ? WHERE id = ?').run(
      timestamp,
      status,
      timestamp,
      row.id,
    );

    const updated = db.prepare(`${ROOM_SELECT} WHERE r.id = ?`).get(row.id);
    return { ok: true, room: roomJson(updated, user) };
  });

  // ---------------- 关闭房间 ----------------

  router.delete('/api/lobby/rooms/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const row = db.prepare('SELECT * FROM lobby_rooms WHERE id = ?').get(Number(ctx.params.id));
    if (!row) return { ok: true, removed: false };
    if (row.owner_id !== user.id && !isAdminRole(user.role)) {
      throw notFound('房间不存在');
    }
    db.prepare('DELETE FROM lobby_rooms WHERE id = ?').run(row.id);
    return { ok: true, removed: true };
  });

  // ---------------- 加入（客户端一键加入，网页端不使用） ----------------

  router.post('/api/lobby/rooms/:id/join', async (ctx) => {
    const row = db.prepare(`${ROOM_SELECT} WHERE r.id = ?`).get(Number(ctx.params.id));
    if (!row || Number(row.heartbeat_at || 0) + TTL_SECONDS < now()) {
      throw notFound('房间已关闭', 'lobby_room_gone');
    }
    enforce(`lobby:join:${ctx.ip}`, 60, 60 * 1000, '加入太频繁，请稍后再试');
    db.prepare('UPDATE lobby_rooms SET join_count = join_count + 1 WHERE id = ?').run(row.id);
    row.join_count = (row.join_count || 0) + 1;
    return { room: roomJson(row, ctx.user) };
  });
}
