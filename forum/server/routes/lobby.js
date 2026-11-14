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
}
