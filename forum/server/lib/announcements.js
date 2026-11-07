/**
 * 启动器公告：管理后台发布，写进官网根目录的 announcement.json。
 *
 * 文件里同时放两类内容：
 *  - announcements：首页公告栏的短公告（一行文字，可带跳转链接）；
 *  - important：启动重要公告（带标题的 Markdown 正文，启动器会弹窗展示，
 *    用户可以勾选「不再弹出这条公告」）。
 *
 * 启动器（C-BlockBox/utils/news/AnnouncementFeed.cpp）会定时拉
 * https://mcblockbox.top/announcement.json，所以这里只要把文件写对，
 * 客户端下次刷新就能看到，不用发版。
 *
 * 数据以后台数据库为准：每次启动会把库里最新的公告重新写回文件，
 * 这样官网仓库里的旧文件、部署时的覆盖都不会把后台发的内容弄丢。
 */
import fs from 'node:fs';
import { config } from '../config.js';
import { db, now, transaction } from '../db.js';
import { HttpError, badRequest, notFound } from './http.js';

/** 与客户端保持一致：最多展示 20 条 */
export const MAX_ENTRIES = 20;
/** 重要公告最多保留多少条历史（同一时间只有一条生效） */
export const MAX_IMPORTANT_ENTRIES = 20;
/** 公告正文长度上限（客户端只显示一行，太长会省略） */
const MAX_TEXT = 200;
/** 重要公告标题 / 正文长度上限（正文支持 Markdown，换行要原样保留） */
const MAX_IMPORTANT_TITLE = 60;
const MAX_IMPORTANT_CONTENT = 5000;
/** 跳转链接长度上限 */
const MAX_LINK = 500;

const KEYS = ['announcements', 'entries', 'items', 'list', 'notices', '公告'];

const normalizeText = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
/** Markdown 正文只统一换行，不能把换行压成空格，否则列表 / 标题会失效 */
const normalizeMarkdown = (value) =>
  String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .trim();

/**
 * 链接只认两种：完整的 http(s) 地址，或以 / 开头的站内路径。
 * 其余（javascript:、mailto: 等）一律当作无效，避免公告文件被写成可执行协议。
 */
function sanitizeLink(value) {
  const link = String(value == null ? '' : value).trim();
  if (!link || link.length > MAX_LINK) return '';
  if (/^https?:\/\//i.test(link)) {
    try {
      const parsed = new URL(link);
      return parsed.host ? link : '';
    } catch {
      return '';
    }
  }
  if (link.startsWith('/') && !link.startsWith('//')) return link;
  return '';
}

/** 取对象里的第一个非空字符串字段（兼容旧公告文件的多种写法） */
function pickString(object, keys) {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** YYYY-MM-DD 按本地时区换算成秒级时间戳，解析不了返回 0 */
function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return 0;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  const seconds = Math.floor(date.getTime() / 1000);
  return Number.isFinite(seconds) ? seconds : 0;
}

/** 秒级时间戳 → 本地日期 YYYY-MM-DD */
function localDate(seconds) {
  const date = new Date(Number(seconds || 0) * 1000);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 解析公告文件。
 * 兼容 { announcements: [...] }、顶层数组、只写一条对象这三种形态，
 * 数组元素可以是字符串或 { text, link, date, enabled }。
 */
function parseEntries(payload) {
  let doc;
  try {
    doc = JSON.parse(payload);
  } catch {
    throw new Error('公告文件不是合法的 JSON');
  }

  let list = [];
  if (Array.isArray(doc)) {
    list = doc;
  } else if (doc && typeof doc === 'object') {
    for (const key of KEYS) {
      if (Array.isArray(doc[key])) {
        list = doc[key];
        break;
      }
      if (doc[key] && typeof doc[key] === 'object') {
        list = [doc[key]];
        break;
      }
    }
  }

  const entries = [];
  for (const item of list) {
    let text = '';
    let link = '';
    let date = '';
    let enabled = true;

    if (typeof item === 'string') {
      text = item;
    } else if (item && typeof item === 'object') {
      text = pickString(item, ['text', 'content', 'message', 'title']);
      link = pickString(item, ['link', 'url', 'href']);
      date = pickString(item, ['date', 'time']);
      enabled = item.enabled !== false && item.hidden !== true;
    } else {
      continue;
    }

    text = normalizeText(text).slice(0, MAX_TEXT);
    if (!text) continue;

    entries.push({
      text,
      link: sanitizeLink(link),
      enabled,
      createdAt: parseDate(date),
    });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

/**
 * 解析文件里的启动重要公告（根对象的 important 字段）。
 * 只认一条：标题 + Markdown 正文 + 可选跳转链接；没有正文视为没发。
 */
function parseImportant(payload) {
  let doc;
  try {
    doc = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;

  const raw = doc.important && typeof doc.important === 'object' ? doc.important : null;
  if (!raw) return null;

  const title = normalizeText(pickString(raw, ['title', 'text', 'name'])).slice(0, MAX_IMPORTANT_TITLE);
  const content = normalizeMarkdown(pickString(raw, ['content', 'markdown', 'body', 'text'])).slice(
    0,
    MAX_IMPORTANT_CONTENT,
  );
  if (!content) return null;

  return {
    title: title || '重要公告',
    content,
    link: sanitizeLink(pickString(raw, ['link', 'url', 'href'])),
    enabled: raw.enabled !== false && raw.hidden !== true,
    createdAt: parseDate(raw.date),
  };
}

/**
 * 读取现有公告文件（启动时用，不拦服务）。
 * readable 表示「文件读到了且是合法 JSON」；文件不存在或解析失败时要小心，
 * 不能拿空列表直接覆盖，否则会把运营手写的内容弄丢。
 */
function readFileEntries() {
  let payload;
  try {
    payload = fs.readFileSync(config.announcementFile, 'utf8');
  } catch {
    return {
      entries: [],
      important: null,
      readable: false,
      exists: fs.existsSync(config.announcementFile),
    };
  }
  try {
    return { entries: parseEntries(payload), important: parseImportant(payload), readable: true, exists: true };
  } catch (error) {
    console.warn(`[公告] ${config.announcementFile} 解析失败：${error.message}，本次跳过导入`);
    return { entries: [], important: null, readable: false, exists: true };
  }
}

/** 把数据库里的首页公告 + 启动重要公告渲染成客户端认识的 JSON */
function serialize(rows, importantRows = []) {
  const announcements = rows.map((row) => {
    const item = {
      id: `a${row.id}`,
      text: row.text,
    };
    if (row.link) item.link = row.link;
    item.date = localDate(row.created_at);
    if (!row.enabled) item.enabled = false;
    return item;
  });

  const doc = { version: 1, updated: localDate(now()), announcements };

  // 同一时间最多只有一条重要公告生效；下线 / 删除后文件里就不再有这个字段
  const active = importantRows.find((row) => row.enabled);
  if (active) {
    doc.important = {
      id: `n${active.id}`,
      title: active.title,
      content: active.content,
      date: localDate(active.created_at),
    };
    if (active.link) doc.important.link = active.link;
  }

  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 数据库公告列表：新的在前（与启动器展示顺序一致） */
export function listAnnouncements() {
  return db
    .prepare(
      'SELECT id, text, link, enabled, created_by, created_at FROM announcements ORDER BY created_at DESC, id DESC',
    )
    .all();
}

function getAnnouncement(id) {
  return db
    .prepare('SELECT id, text, link, enabled, created_by, created_at FROM announcements WHERE id = ?')
    .get(id);
}

/** 重要公告历史：新的在前；enabled = 1 的那条就是启动器弹窗展示的公告 */
export function listImportantAnnouncements() {
  return db
    .prepare(
      `SELECT id, title, content, link, enabled, created_by, created_at
         FROM important_announcements
        ORDER BY created_at DESC, id DESC`,
    )
    .all();
}

/**
 * 当前生效的启动重要公告（同一时间只让一条生效）。
 * 启动器启动时弹窗用它，官网与论坛打开时也弹同一条，所以前后端都以这里的格式为准。
 */
export function getActiveImportantAnnouncement() {
  const row = db
    .prepare(
      `SELECT id, title, content, link, created_at
         FROM important_announcements
        WHERE enabled = 1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .get();
  if (!row) return null;

  const item = {
    id: `n${row.id}`,
    title: row.title || '重要公告',
    content: row.content,
    date: localDate(row.created_at),
  };
  if (row.link) item.link = row.link;
  return item;
}

function getImportantAnnouncement(id) {
  return db
    .prepare(
      `SELECT id, title, content, link, enabled, created_by, created_at
         FROM important_announcements WHERE id = ?`,
    )
    .get(id);
}

/**
 * 把给定公告写进官网文件。
 * 文件默认只有论坛服务用户可写，所以这里直接覆盖写；写失败时抛出的错误
 * 会原样显示在管理后台，方便值班同学一眼看出是路径还是权限问题。
 */
function writeAnnouncementFile(rows, importantRows = listImportantAnnouncements()) {
  try {
    fs.writeFileSync(config.announcementFile, serialize(rows, importantRows), 'utf8');
  } catch (error) {
    throw new HttpError(
      500,
      `写入官网公告文件失败：${config.announcementFile}（${error.code || error.message}）。请确认论坛服务对该文件有写权限。`,
      'announcement_write_failed',
    );
  }
}

/** 文件写入失败时把「哪条重要公告生效」恢复成修改前的状态 */
function restoreEnabledImportant(previousEnabledIds) {
  transaction(() => {
    db.prepare('UPDATE important_announcements SET enabled = 0').run();
    const enable = db.prepare('UPDATE important_announcements SET enabled = 1 WHERE id = ?');
    for (const id of previousEnabledIds) enable.run(id);
  });
}

/** 发布一条公告：先落库，再写文件；文件写不进去就回滚这条记录 */
export function publishAnnouncement({ text, link, admin }) {
  const cleanText = normalizeText(text);
  if (!cleanText) throw badRequest('公告内容不能为空');
  if (cleanText.length > MAX_TEXT) throw badRequest(`公告内容最多 ${MAX_TEXT} 个字`);

  const rawLink = String(link == null ? '' : link).trim();
  const cleanLink = sanitizeLink(rawLink);
  if (rawLink && !cleanLink) {
    throw badRequest('跳转链接只支持 http(s):// 完整地址，或以 / 开头的站内路径');
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n;
  if (total >= MAX_ENTRIES) {
    throw badRequest(`首页公告最多 ${MAX_ENTRIES} 条，先在列表里删掉旧的再发布`);
  }

  const createdBy = String(admin?.display_name || admin?.username || '').slice(0, 40);
  const result = db
    .prepare('INSERT INTO announcements (text, link, enabled, created_by, created_at) VALUES (?, ?, 1, ?, ?)')
    .run(cleanText, cleanLink, createdBy, now());
  const id = Number(result.lastInsertRowid);

  try {
    writeAnnouncementFile(listAnnouncements());
  } catch (error) {
    db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
    throw error;
  }

  return getAnnouncement(id);
}

/** 删除一条公告：先把剩余内容写进文件，成功后再删库 */
export function removeAnnouncement(id) {
  const numeric = Math.floor(Number(id));
  if (!numeric) throw notFound('公告不存在');
  const row = getAnnouncement(numeric);
  if (!row) throw notFound('公告不存在');

  const remaining = listAnnouncements().filter((item) => item.id !== numeric);
  writeAnnouncementFile(remaining);
  db.prepare('DELETE FROM announcements WHERE id = ?').run(numeric);
  return row;
}

/**
 * 发布一条启动重要公告。
 * 新发布的会自动顶替旧的（同一时间只弹一条），旧记录保留在后台历史里，
 * 需要时可以重新上线。
 */
export function publishImportantAnnouncement({ title, content, link, admin }) {
  const cleanTitle = normalizeText(title).slice(0, MAX_IMPORTANT_TITLE) || '重要公告';
  const cleanContent = normalizeMarkdown(content);
  if (!cleanContent) throw badRequest('重要公告正文不能为空');
  if (cleanContent.length > MAX_IMPORTANT_CONTENT) {
    throw badRequest(`重要公告正文最多 ${MAX_IMPORTANT_CONTENT} 个字`);
  }

  const rawLink = String(link == null ? '' : link).trim();
  const cleanLink = sanitizeLink(rawLink);
  if (rawLink && !cleanLink) {
    throw badRequest('跳转链接只支持 http(s):// 完整地址，或以 / 开头的站内路径');
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM important_announcements').get().n;
  if (total >= MAX_IMPORTANT_ENTRIES) {
    throw badRequest(`重要公告最多保留 ${MAX_IMPORTANT_ENTRIES} 条记录，先在列表里删掉旧的再发布`);
  }

  const previousEnabled = listImportantAnnouncements()
    .filter((row) => row.enabled)
    .map((row) => row.id);
  const createdBy = String(admin?.display_name || admin?.username || '').slice(0, 40);

  let id = 0;
  transaction(() => {
    const result = db
      .prepare(
        'INSERT INTO important_announcements (title, content, link, enabled, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?)',
      )
      .run(cleanTitle, cleanContent, cleanLink, createdBy, now());
    id = Number(result.lastInsertRowid);
    db.prepare('UPDATE important_announcements SET enabled = 0 WHERE id != ?').run(id);
  });

  try {
    writeAnnouncementFile(listAnnouncements());
  } catch (error) {
    db.prepare('DELETE FROM important_announcements WHERE id = ?').run(id);
    restoreEnabledImportant(previousEnabled);
    throw error;
  }

  return getImportantAnnouncement(id);
}

/** 上线 / 下线一条重要公告：上线时自动把其它公告下线 */
export function setImportantAnnouncementEnabled(id, enabled) {
  const numeric = Math.floor(Number(id));
  if (!numeric) throw notFound('重要公告不存在');
  const row = getImportantAnnouncement(numeric);
  if (!row) throw notFound('重要公告不存在');

  const previousEnabled = listImportantAnnouncements()
    .filter((item) => item.enabled)
    .map((item) => item.id);

  transaction(() => {
    if (enabled) {
      db.prepare('UPDATE important_announcements SET enabled = 0').run();
      db.prepare('UPDATE important_announcements SET enabled = 1 WHERE id = ?').run(numeric);
    } else {
      db.prepare('UPDATE important_announcements SET enabled = 0 WHERE id = ?').run(numeric);
    }
  });

  try {
    writeAnnouncementFile(listAnnouncements());
  } catch (error) {
    restoreEnabledImportant(previousEnabled);
    throw error;
  }

  return getImportantAnnouncement(numeric);
}

/** 删除一条重要公告：先把剩余内容写进文件，成功后再删库 */
export function removeImportantAnnouncement(id) {
  const numeric = Math.floor(Number(id));
  if (!numeric) throw notFound('重要公告不存在');
  const row = getImportantAnnouncement(numeric);
  if (!row) throw notFound('重要公告不存在');

  const remaining = listImportantAnnouncements().filter((item) => item.id !== numeric);
  writeAnnouncementFile(listAnnouncements(), remaining);
  db.prepare('DELETE FROM important_announcements WHERE id = ?').run(numeric);
  return row;
}

/** 公告文件当前状态，管理后台用来提示「能不能写」 */
export function announcementStatus() {
  const file = config.announcementFile;
  let exists = false;
  let writable = false;

  try {
    exists = fs.statSync(file).isFile();
  } catch {
    exists = false;
  }
  if (exists) {
    let handle = null;
    try {
      // 用 r+ 真开一次写句柄：能准确看出 systemd 的只读挂载 / 系统权限，
      // 比只看文件权限位可靠（ProtectSystem=strict 时 access 仍会返回可写）。
      handle = fs.openSync(file, 'r+');
      writable = true;
    } catch {
      writable = false;
    } finally {
      if (handle !== null) {
        try {
          fs.closeSync(handle);
        } catch {
          /* 关不上也不影响状态判断 */
        }
      }
    }
  }

  return { path: file, exists, writable };
}

/**
 * 启动时同步：
 * 1. 公告表为空时，从现有 announcement.json 导入（首次上线不丢旧公告）；
 * 2. 把数据库里的最新公告重新写回文件（部署覆盖 / 文件被改坏时自动修复）。
 */
export function initAnnouncements() {
  try {
    const announcementsEmpty = db.prepare('SELECT COUNT(*) AS n FROM announcements').get().n === 0;
    const importantEmpty =
      db.prepare('SELECT COUNT(*) AS n FROM important_announcements').get().n === 0;

    if (announcementsEmpty || importantEmpty) {
      const { entries, important, readable, exists } = readFileEntries();

      if (announcementsEmpty) {
        if (entries.length) {
          let previous = now();
          const insert = db.prepare(
            'INSERT INTO announcements (text, link, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
          );
          transaction(() => {
            for (const entry of entries) {
              // 文件顺序就是展示顺序，用递减的时间戳把它原样保留下来
              let created = entry.createdAt || previous;
              if (created >= previous) created = previous - 1;
              previous = created;
              insert.run(entry.text, entry.link, entry.enabled ? 1 : 0, '官网文件', created);
            }
          });
          console.log(`[公告] 已从 ${config.announcementFile} 导入 ${entries.length} 条首页公告`);
        } else if (exists && !readable) {
          // 文件在但解析不了：可能是手滑改坏了，保留原文件让人工处理，别用空列表盖掉
          console.warn(`[公告] ${config.announcementFile} 内容无法解析，已保留原文件；修好后再重启，或直接在管理后台发布。`);
          return;
        }
      }

      if (importantEmpty && important) {
        db.prepare(
          `INSERT INTO important_announcements (title, content, link, enabled, created_by, created_at)
           VALUES (?, ?, ?, ?, '官网文件', ?)`,
        ).run(
          important.title,
          important.content,
          important.link,
          important.enabled ? 1 : 0,
          important.createdAt || now(),
        );
        console.log(`[公告] 已从 ${config.announcementFile} 导入启动重要公告：${important.title}`);
      }
    }

    const rows = listAnnouncements();
    writeAnnouncementFile(rows);
    console.log(`[公告] 首页公告已同步 ${rows.length} 条 → ${config.announcementFile}`);
  } catch (error) {
    console.warn(`[公告] 首页公告同步失败：${error.message}`);
  }
}
