import crypto from 'node:crypto';
import { db, now, paginate } from '../db.js';
import { HttpError, badRequest, notFound } from '../lib/http.js';
import { assertCanPost, isAdminRole, requireUser } from '../lib/auth.js';
import { enforce } from '../lib/rate-limit.js';
import { int, text } from '../lib/validate.js';
import { guardBannedWords } from '../lib/banned-words.js';

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
/** 「正在游玩」的上报有效期：客户端进游戏后每 40 秒一次，断了 2 分钟就当作已经离开 */
const PLAYER_TTL_SECONDS = 120;

/** 清掉已经久到不可能再有心跳的房间 */
function purgeStale() {
  db.prepare('DELETE FROM lobby_rooms WHERE heartbeat_at < ?').run(now() - TTL_SECONDS);
  purgeStalePlayers();
}

/** 清掉早就不再上报的「正在游玩」记录 */
function purgeStalePlayers() {
  db.prepare('DELETE FROM lobby_players WHERE heartbeat_at < ?').run(now() - PLAYER_TTL_SECONDS);
}

function parseMods(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 把发布 body 里的字符串数组收成干净的列表：去空白、去重、限长限数。
 * 大厅的模组 / 资源包 / 光影包都用它，避免个别超长文件名撑爆房间数据。
 */
function readNameList(raw, max, maxLength) {
  const list = [];
  if (!Array.isArray(raw)) return list;
  for (const item of raw.slice(0, max)) {
    const name = String(item == null ? '' : item).trim().slice(0, maxLength);
    if (name && !list.includes(name)) list.push(name);
  }
  return list;
}

/** 辅助模组只保留 mods 里真实存在的项，防止两边对不上 */
function cleanAuxMods(aux, mods) {
  if (!aux.length) return [];
  const known = new Set(mods);
  return aux.filter((name) => known.has(name));
}

function parsePackMeta(raw) {
  try {
    const meta = JSON.parse(raw || '{}');
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  } catch {
    return {};
  }
}

/** 封面只认站内图床路径，别的（外链、协议串）一律丢掉存空 */
function normalizeCover(raw) {
  const value = String(raw || '').trim();
  return value.startsWith('/uploads/') && value.length <= 200 ? value : '';
}

/** 在线整合包的下载地址只收 http(s)，网盘链接同样只收 http(s) */
function normalizePackUrl(raw) {
  try {
    const parsed = new URL(String(raw || '').trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href.slice(0, 500)
      : '';
  } catch {
    return '';
  }
}

/** 房间的一条「正在游玩」记录（字段和 host 对齐，客户端可以直接拿来画头像） */
function playerJson(row, hostId) {
  return {
    id: row.user_id,
    username: row.username || '',
    display_name: row.display_name || row.username || '',
    avatar: row.avatar || '',
    joined_at: row.joined_at,
    is_host: row.user_id === hostId,
  };
}

const PLAYER_SELECT = `
  SELECT p.room_id, p.user_id, p.joined_at, u.username, u.display_name, u.avatar
    FROM lobby_players p
    JOIN users u ON u.id = p.user_id`;

/** 一次把所有房间的「正在游玩」玩家取回来，列表接口不用一间房查一次 */
function loadPlayersByRoom(roomIds) {
  const map = new Map();
  const ids = (roomIds || []).filter((id) => Number(id) > 0);
  if (!ids.length) return map;
  const rows = db
    .prepare(
      `${PLAYER_SELECT}
        WHERE p.room_id IN (${ids.map(() => '?').join(',')})
          AND p.heartbeat_at >= ?
        ORDER BY p.joined_at ASC, p.user_id ASC`,
    )
    .all(...ids, now() - PLAYER_TTL_SECONDS);
  for (const row of rows) {
    const list = map.get(row.room_id) || [];
    list.push(row);
    map.set(row.room_id, list);
  }
  return map;
}

/**
 * 「正在游玩」列表：房主永远排第一（房间还在就说明房主在房间里），
 * 后面按进房时间排通过客户端进游戏的其他玩家。
 */
function playersOf(row, playerRows) {
  const players = [
    {
      id: row.owner_id,
      username: row.owner_username || '',
      display_name: row.owner_display_name || row.owner_username || '',
      avatar: row.owner_avatar || '',
      joined_at: row.created_at,
      is_host: true,
    },
  ];
  for (const item of playerRows || []) {
    if (item.user_id === row.owner_id) continue;
    players.push(playerJson(item, row.owner_id));
  }
  return players;
}

function roomJson(row, viewer, playerRows) {
  if (!row) return null;
  // playerRows 由列表接口一次性传入；单间接口自己查一次就够
  const rows = playerRows === undefined
    ? loadPlayersByRoom([row.id]).get(row.id) || []
    : playerRows;
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
    mods_aux: parseMods(row.mods_aux),
    resource_packs: parseMods(row.resource_packs),
    shader_packs: parseMods(row.shader_packs),
    max_players: row.max_players,
    cover: row.cover || '',
    md: row.md || '',
    modpack_mode: row.modpack_mode || '',
    modpack_name: row.modpack_name || '',
    modpack_url: row.modpack_url || '',
    modpack_meta: parsePackMeta(row.modpack_meta),
    status: row.status,
    join_count: row.join_count || 0,
    host: {
      id: row.owner_id,
      username: row.owner_username || '',
      display_name: row.owner_display_name || row.owner_username || '',
      avatar: row.owner_avatar || '',
    },
    // 正在游玩的人：房主 + 通过客户端进游戏、还在上报的玩家
    players: playersOf(row, rows),
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

// ---------------------------------------------------------------- 分享短链
//
// 「创建分享链接」时客户端把房间信息传到 /api/lobby/shares，拿回一段很短的房间号，
// 链接就只带这个房间号（join.html?r=房间号），网页和客户端都按房间号回来取数据。
// 房主联机期间每 40 秒续一次心跳，联机结束（客户端主动删除 / 心跳断了超过 2 分钟）
// 数据就没了，打开老链接时会提示「联机可能已经结束」。

const SHARE_TTL_SECONDS = 120;
/** 房间号字母表：去掉容易看错的 0/1/i/l/o，复制出来不容易认错 */
const SHARE_TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const SHARE_TOKEN_LENGTH = 8;
const SHARE_TOKEN_RE = /^[a-z0-9]{6,24}$/;

/** 清掉早就没有心跳的分享 */
function purgeStaleShares() {
  db.prepare('DELETE FROM lobby_shares WHERE heartbeat_at < ?').run(now() - SHARE_TTL_SECONDS);
}

/** 生成一个没被占用的房间号 */
function newShareToken() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let token = '';
    for (const byte of crypto.randomBytes(SHARE_TOKEN_LENGTH)) {
      token += SHARE_TOKEN_ALPHABET[byte % SHARE_TOKEN_ALPHABET.length];
    }
    if (!db.prepare('SELECT 1 FROM lobby_shares WHERE token = ?').get(token)) return token;
  }
  throw new HttpError(500, '生成房间号失败，请稍后再试', 'share_token_failed');
}

/** 分享链接里的房间号（老链接 / 乱填的都当成「找不到」处理） */
function readShareToken(raw) {
  const token = String(raw || '').trim().toLowerCase();
  return SHARE_TOKEN_RE.test(token) ? token : '';
}

/** 分享数据里能落库的字段（t 房间名 / ds 简介 / c 核心 / ic 邀请码 …）：和网页 join.html 的紧凑字段一一对应 */
function readSharePayload(body) {
  const title = text(body.t, { field: '房间名', max: 40, optional: true }) || '联机房间';
  const description = text(body.ds, { field: '房间简介', max: 200, optional: true });
  const core = CORE_KEYS.includes(String(body.c)) ? String(body.c) : 'custom';
  const inviteCode = text(body.ic, { field: '邀请码', max: 120, optional: true });
  const address = text(body.ad, { field: '连接地址', max: 120, optional: true });
  if (!inviteCode && !address) {
    throw badRequest('请提供邀请码或连接地址', 'lobby_join_info_required');
  }
  const gameVersion = text(body.v, { field: '游戏版本', max: 32, optional: true });
  const loader = text(body.ld, { field: '加载器', max: 32, optional: true });
  const mods = readNameList(body.md, 80, 120);
  // 辅助模组只保留 mods 里真实存在的项，防止两边对不上
  const auxMods = cleanAuxMods(readNameList(body.ma, 80, 120), mods);
  return {
    t: title,
    ds: description,
    c: core,
    ic: inviteCode,
    ad: address,
    v: gameVersion,
    ld: loader,
    md: mods,
    ma: auxMods,
    rp: readNameList(body.rp, 40, 160),
    sp: readNameList(body.sp, 40, 160),
  };
}

function parseSharePayload(raw) {
  try {
    const payload = JSON.parse(raw || '{}');
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  } catch {
    return {};
  }
}

/** 取一条还在有效期内的分享；过期 / 不存在返回 null */
function liveShare(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM lobby_shares WHERE token = ?').get(token);
  if (!row) return null;
  if (Number(row.heartbeat_at || 0) + SHARE_TTL_SECONDS < now()) return null;
  return row;
}

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
  // 辅助模组（客户端可选）只是 mods 的子集标注；资源包 / 光影包各自独立列表
  const modsAux = cleanAuxMods(readNameList(body.mods_aux, 80, 120), mods);
  const resourcePacks = readNameList(body.resource_packs, 40, 160);
  const shaderPacks = readNameList(body.shader_packs, 40, 160);

  const maxPlayers = int(body.max_players, { field: '人数上限', min: 1, max: 64, fallback: 8 });
  const status = STATUS_KEYS.includes(String(body.status)) ? String(body.status) : 'waiting';

  // 封面：只收站内图床路径（发布前先 POST /api/upload 拿 url 再带上）
  const cover = normalizeCover(body.cover);

  // Markdown 介绍：一刀 8000 字，转空白行边界交给展示端
  const md = text(body.md, { field: '详细介绍', max: 8000, optional: true });

  // 前置整合包：在线（从 CurseForge/Modrinth 挑的，带下载地址）或链接（名称 + 网盘地址）
  // mode 缺省 = 没填；online 必须有可下载地址，link 只要求名字
  let modpackMode = String(body.modpack_mode || '').trim();
  if (modpackMode !== 'online' && modpackMode !== 'link') modpackMode = '';
  let modpackName = text(body.modpack_name, { field: '整合包名称', max: 200, optional: true });
  const modpackUrl = normalizePackUrl(body.modpack_url);
  let modpackMeta = {};
  if (body.modpack_meta && typeof body.modpack_meta === 'object' && !Array.isArray(body.modpack_meta)) {
    for (const key of ['platform', 'author', 'version', 'file_name', 'file_size', 'page_url']) {
      if (body.modpack_meta[key] !== undefined) modpackMeta[key] = body.modpack_meta[key];
    }
  }
  const modpackMetaJson = JSON.stringify(modpackMeta).slice(0, 2000);

  if (modpackMode === 'online') {
    if (!modpackName) throw badRequest('请填写整合包名称', 'lobby_modpack_name_required');
    if (!modpackUrl) throw badRequest('在线整合包需要一个可下载的 http(s) 地址', 'lobby_modpack_url_required');
  } else if (modpackMode === 'link') {
    if (!modpackName) throw badRequest('请填写整合包名称', 'lobby_modpack_name_required');
    if (!modpackUrl) modpackMode = '';
  }

  return {
    title, description, core, inviteCode, address, gameVersion, loader, mods, modsAux,
    resourcePacks, shaderPacks, maxPlayers, status,
    cover, md, modpackMode, modpackName, modpackUrl, modpackMetaJson,
  };
}

// ---------------------------------------------------------------- 房间评论
//
// 详情页里大家对着房间留言：记住谁在什么时候说了什么，房主和评论者自己可以删。
// 评论跟着房间一起走：房间过期下架（超过 2 分钟没心跳）时服务端会把房间删掉，
// 评论由外键级联清理，不会在大厅里堆一辈子。

/** 一条评论最多 300 字，够说清楚「哪个模组对不上 / 什么时候一起玩」这类话 */
const COMMENT_MAX_LENGTH = 300;
/** 详情页一次最多回最近 50 条，再多就不往下翻了（房间本来就只活一小会儿） */
const COMMENT_LIMIT = 50;

const COMMENT_SELECT = `
  SELECT c.id, c.user_id, c.content, c.created_at,
         u.username, u.display_name, u.avatar, u.role
    FROM lobby_comments c
    JOIN users u ON u.id = c.user_id`;

/** 评论的对外结构（客户端直接拿去画头像、名字和「房主」标签） */
function commentJson(row, viewer, roomOwnerId) {
  return {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    // 房主自己留言时客户端会挂一个「房主」小标签
    is_host: row.user_id === roomOwnerId,
    mine: !!(viewer && viewer.id === row.user_id),
    user: {
      id: row.user_id,
      username: row.username || '',
      display_name: row.display_name || row.username || '',
      avatar: row.avatar || '',
      role: row.role || 'user',
    },
  };
}

/** 只有还在心跳有效期内的房间才能看 / 发评论，过期房间直接当作已经关闭 */
function liveRoom(roomId) {
  const row = db
    .prepare('SELECT id, owner_id, heartbeat_at FROM lobby_rooms WHERE id = ?')
    .get(roomId);
  if (!row || Number(row.heartbeat_at || 0) + TTL_SECONDS < now()) return null;
  return row;
}

export default function register(router) {
  // ---------------- 房间列表（公开）----------------

  router.get('/api/lobby/rooms', async (ctx) => {
    purgeStale();
    purgeStaleShares();

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
    // 正在游玩的人一次性取回来，避免每间房各查一次
    const playersByRoom = loadPlayersByRoom(rows.map((row) => row.id));

    return {
      rooms: rows.map((row) => roomJson(row, ctx.user, playersByRoom.get(row.id) || [])),
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
                game_version = ?, loader = ?, mods = ?, mods_aux = ?,
                resource_packs = ?, shader_packs = ?, max_players = ?,
                cover = ?, md = ?, modpack_mode = ?, modpack_name = ?, modpack_url = ?, modpack_meta = ?,
                status = ?, heartbeat_at = ?, updated_at = ?
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
        JSON.stringify(room.modsAux),
        JSON.stringify(room.resourcePacks),
        JSON.stringify(room.shaderPacks),
        room.maxPlayers,
        room.cover,
        room.md,
        room.modpackMode,
        room.modpackName,
        room.modpackUrl,
        room.modpackMetaJson,
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
              mods, mods_aux, resource_packs, shader_packs, max_players,
              cover, md, modpack_mode, modpack_name, modpack_url, modpack_meta,
              status, join_count, heartbeat_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
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
          JSON.stringify(room.modsAux),
          JSON.stringify(room.resourcePacks),
          JSON.stringify(room.shaderPacks),
          room.maxPlayers,
          room.cover,
          room.md,
          room.modpackMode,
          room.modpackName,
          room.modpackUrl,
          room.modpackMetaJson,
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

  // ---------------- 正在游玩：客户端进游戏后上报 ----------------
  //
  // 客户端「一键加入」后游戏真正跑起来时开始每 40 秒上报一次，游戏退出立刻删掉；
  // 断线 / 强退时 2 分钟没上报也会被当作已经离开，大厅里不会一直挂着不玩的人。

  router.post('/api/lobby/rooms/:id/presence', async (ctx) => {
    const user = requireUser(ctx.user);
    const room = db
      .prepare('SELECT id, owner_id, heartbeat_at FROM lobby_rooms WHERE id = ?')
      .get(Number(ctx.params.id));
    if (!room || Number(room.heartbeat_at || 0) + TTL_SECONDS < now()) {
      throw notFound('房间已关闭', 'lobby_room_gone');
    }
    // 40 秒一次上报，留出重试的余量
    enforce(`lobby:presence:${user.id}`, 40, 60 * 1000, '上报太频繁，请稍后再试');

    const timestamp = now();
    // 同一个房间同一个人只留一条：重新进房不刷新 joined_at，头像墙的顺序就不会乱跳
    db.prepare(
      `INSERT INTO lobby_players (room_id, user_id, joined_at, heartbeat_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(room_id, user_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`,
    ).run(room.id, user.id, timestamp, timestamp);

    const fresh = db.prepare(`${ROOM_SELECT} WHERE r.id = ?`).get(room.id);
    return { ok: true, room: roomJson(fresh, user) };
  });

  router.delete('/api/lobby/rooms/:id/presence', async (ctx) => {
    const user = requireUser(ctx.user);
    db.prepare('DELETE FROM lobby_players WHERE room_id = ? AND user_id = ?').run(
      Number(ctx.params.id),
      user.id,
    );
    return { ok: true };
  });

  // ---------------- 分享短链：创建 / 读取 / 续期 / 删除 ----------------

  // 创建：把房间信息存进来，只把很短的一段房间号做成链接发给别人
  router.post('/api/lobby/shares', async (ctx) => {
    purgeStaleShares();
    enforce(`lobby:share:${ctx.ip}`, 20, 60 * 1000, '创建分享链接太频繁，请稍后再试');

    const payload = readSharePayload(await ctx.json());
    const token = newShareToken();
    // 续期 / 删除凭据只回给创建者：别人拿到链接也改不了、删不掉这条数据
    const secret = crypto.randomBytes(18).toString('base64url');
    const timestamp = now();

    db.prepare(
      `INSERT INTO lobby_shares (token, secret, payload, owner_id, created_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(token, secret, JSON.stringify(payload), ctx.user ? ctx.user.id : 0, timestamp, timestamp);

    return { token, secret, expires_in: SHARE_TTL_SECONDS };
  });

  // 读取：网页邀请页和客户端打开分享链接时都走这里；联机结束后就是 404
  router.get('/api/lobby/shares/:token', async (ctx) => {
    purgeStaleShares();
    const row = liveShare(readShareToken(ctx.params.token));
    if (!row) {
      throw notFound('联机可能已经结束', 'lobby_share_gone');
    }
    return {
      share: parseSharePayload(row.payload),
      expires_in: Math.max(0, Number(row.heartbeat_at || 0) + SHARE_TTL_SECONDS - now()),
    };
  });

  // 续期：房主联机期间每 40 秒一次
  router.post('/api/lobby/shares/:token/heartbeat', async (ctx) => {
    const body = await ctx.json();
    const row = db.prepare('SELECT * FROM lobby_shares WHERE token = ?').get(
      readShareToken(ctx.params.token),
    );
    if (!row || row.secret !== String(body.secret || '')) {
      throw notFound('联机可能已经结束', 'lobby_share_gone');
    }
    if (Number(row.heartbeat_at || 0) + SHARE_TTL_SECONDS < now()) {
      db.prepare('DELETE FROM lobby_shares WHERE token = ?').run(row.token);
      throw notFound('联机可能已经结束', 'lobby_share_gone');
    }
    db.prepare('UPDATE lobby_shares SET heartbeat_at = ? WHERE token = ?').run(now(), row.token);
    return { ok: true, expires_in: SHARE_TTL_SECONDS };
  });

  // 删除：房主结束联机 / 关闭软件时立刻让链接失效
  router.delete('/api/lobby/shares/:token', async (ctx) => {
    const body = await ctx.json();
    const token = readShareToken(ctx.params.token);
    const row = token ? db.prepare('SELECT * FROM lobby_shares WHERE token = ?').get(token) : null;
    if (row && row.secret === String(body.secret || '')) {
      db.prepare('DELETE FROM lobby_shares WHERE token = ?').run(row.token);
    }
    return { ok: true };
  });

  // ---------------- 房间评论：详情页留言 ----------------
  //
  // 读评论公开；发评论要求登录且通过入站答题（和发帖 / 回复同一套资格），
  // 删除允许评论者本人、房主和管理员。

  router.get('/api/lobby/rooms/:id/comments', async (ctx) => {
    purgeStale();
    const room = liveRoom(Number(ctx.params.id));
    if (!room) {
      throw notFound('房间已关闭', 'lobby_room_gone');
    }

    const total = db
      .prepare('SELECT COUNT(*) AS n FROM lobby_comments WHERE room_id = ?')
      .get(room.id).n;
    // 按时间倒序取最近一批，再翻正成「旧的在上面、新留言接在下面」
    const rows = db
      .prepare(`${COMMENT_SELECT} WHERE c.room_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT ?`)
      .all(room.id, COMMENT_LIMIT)
      .reverse();

    return {
      comments: rows.map((row) => commentJson(row, ctx.user, room.owner_id)),
      total,
      room_id: room.id,
    };
  });

  router.post('/api/lobby/rooms/:id/comments', async (ctx) => {
    // 和发帖 / 回复一致：没登录、被禁言、没通过入站答题都不让发
    const user = assertCanPost(ctx.user, 'reply');
    const room = liveRoom(Number(ctx.params.id));
    if (!room) {
      throw notFound('房间已关闭', 'lobby_room_gone');
    }
    enforce(`lobby:comment:${user.id}`, 8, 60 * 1000, '评论太频繁，歇一会儿再发');

    const body = await ctx.json();
    const content = text(body.content, { field: '评论', min: 1, max: COMMENT_MAX_LENGTH });
    guardBannedWords(user, content, { action: '评论' });

    const timestamp = now();
    const result = db
      .prepare('INSERT INTO lobby_comments (room_id, user_id, content, created_at) VALUES (?, ?, ?, ?)')
      .run(room.id, user.id, content, timestamp);
    const row = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(Number(result.lastInsertRowid));

    return { comment: commentJson(row, user, room.owner_id) };
  });

  router.delete('/api/lobby/comments/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const row = db
      .prepare(
        `SELECT c.id, c.user_id, r.owner_id
           FROM lobby_comments c
           JOIN lobby_rooms r ON r.id = c.room_id
          WHERE c.id = ?`,
      )
      .get(Number(ctx.params.id));
    if (!row) return { ok: true, removed: false };
    // 评论者自己、房主（清理自己房间里的留言）、管理员都能删
    if (row.user_id !== user.id && row.owner_id !== user.id && !isAdminRole(user.role)) {
      throw notFound('评论不存在');
    }
    db.prepare('DELETE FROM lobby_comments WHERE id = ?').run(row.id);
    return { ok: true, removed: true };
  });
}
