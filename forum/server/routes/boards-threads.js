import { db, paginate, now, transaction, refreshBoardCounts } from '../db.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { assertCanPost, isAdminRole, requireAdmin, requireUser } from '../lib/auth.js';
import { enforce } from '../lib/rate-limit.js';
import { bool, text } from '../lib/validate.js';
import { boardOut, postOut, threadOut, snippetOf } from '../lib/serialize.js';
import { notifyThreadActivity } from '../lib/notify.js';
import { guardBannedWords } from '../lib/banned-words.js';
import { cdnBase } from '../lib/cdn.js';
import { config } from '../config.js';

const pluginDownloadSeen = new Map();
import {
  siteStats,
  getThread,
  listPosts,
  countPosts,
  listChildPosts,
  likedPostIds,
  listThreads,
  countThreads,
  listBookmarkedThreads,
  countBookmarkedThreads,
  popularTags,
} from '../lib/queries.js';

const VALID_SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;
const viewSeen = new Map();

/** 标签：数组或逗号/空格分隔的字符串，最多 4 个，每个最多 12 字 */
function parseTags(input) {
  if (input === undefined || input === null) return [];
  const raw = Array.isArray(input) ? input : String(input).split(/[,，、\s]+/);
  const tags = [];
  for (const item of raw) {
    const tag = String(item).trim().replace(/^#+/, '').slice(0, 12);
    if (!tag) continue;
    if (!tags.includes(tag)) tags.push(tag);
    if (tags.length >= 4) break;
  }
  return tags;
}

function saveTags(threadId, tags) {
  db.prepare('DELETE FROM thread_tags WHERE thread_id = ?').run(threadId);
  const insert = db.prepare('INSERT OR IGNORE INTO thread_tags (thread_id, tag) VALUES (?, ?)');
  for (const tag of tags) insert.run(threadId, tag);
}

function boardBySlug(slug) {
  return db.prepare('SELECT * FROM boards WHERE slug = ?').get(slug);
}

function boardById(id) {
  return db.prepare('SELECT * FROM boards WHERE id = ?').get(id);
}

/** 刷新主题搜索索引 */
/** 通知失败不能影响已经发出去的帖子，这里兜一层 */
function safeNotify(payload) {
  try {
    notifyThreadActivity(payload);
  } catch (error) {
    console.error('[论坛] 生成通知失败（不影响发帖）：', error.message);
  }
}

function indexThread(threadId) {
  const row = db
    .prepare(
      `SELECT t.id, t.board_id, t.title,
              (SELECT group_concat(content, ' ') FROM (
                 SELECT content FROM posts WHERE thread_id = t.id AND deleted = 0 ORDER BY floor LIMIT 20
               )) AS body
         FROM threads t WHERE t.id = ?`,
    )
    .get(threadId);
  if (!row) return;
  const body = (row.body || '').slice(0, 20000);
  db.prepare(
    `INSERT INTO thread_search (thread_id, board_id, title, body, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       board_id = excluded.board_id,
       title = excluded.title,
       body = excluded.body,
       updated_at = excluded.updated_at`,
  ).run(row.id, row.board_id, row.title, body, now());
}

function addSearchEntry(threadId, extraText) {  db.prepare(
    `UPDATE thread_search SET body = substr(body || ' ' || ?, 1, 40000), updated_at = ? WHERE thread_id = ?`,
  ).run(extraText, now(), threadId);
}

export default function register(router) {
  // ---------------- 板块 ----------------

  router.get('/api/boards', async () => {
    const rows = db
      .prepare(
        `SELECT b.*,
                (SELECT t.id FROM threads t WHERE t.board_id = b.id AND t.deleted = 0
                  ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT 1) AS last_thread_id,
                (SELECT t.title FROM threads t WHERE t.board_id = b.id AND t.deleted = 0
                  ORDER BY t.pinned DESC, t.last_post_at DESC LIMIT 1) AS last_thread_title
           FROM boards b ORDER BY b.sort_order ASC, b.id ASC`,
      )
      .all();
    return {
      boards: rows.map((row) => ({
        ...boardOut(row),
        last_thread: row.last_thread_id
          ? { id: row.last_thread_id, title: row.last_thread_title }
          : null,
      })),
      stats: siteStats(),
    };
  });

  router.get('/api/boards/:slug', async (ctx) => {
    const board = boardBySlug(ctx.params.slug);
    if (!board) throw notFound('板块不存在');

    const { page, perPage, offset } = paginate(ctx.url.searchParams, 25);
    const sort = ['latest', 'new', 'hot'].includes(ctx.url.searchParams.get('sort') || '')
      ? ctx.url.searchParams.get('sort')
      : 'latest';
    const tag = String(ctx.url.searchParams.get('tag') || '').trim().slice(0, 20);

    const rows = listThreads({ boardId: board.id, tag, sort, limit: perPage, offset });
    const total = countThreads({ boardId: board.id, tag });

    return {
      board: boardOut(board),
      tag: tag || null,
      threads: rows.map((row) => threadOut(row)),
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  // ---------------- 主题列表 ----------------

  router.get('/api/threads', async (ctx) => {
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);
    const sort = ['latest', 'new', 'hot'].includes(ctx.url.searchParams.get('sort') || '')
      ? ctx.url.searchParams.get('sort')
      : 'latest';
    const tag = String(ctx.url.searchParams.get('tag') || '').trim().slice(0, 20);
    const rows = listThreads({ tag, sort, limit: perPage, offset });
    const total = countThreads({ tag });
    return {
      threads: rows.map((row) => threadOut(row)),
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  // ---------------- 标签 ----------------

  router.get('/api/tags', async () => {
    const popular = popularTags(40);
    const featured = db
      .prepare('SELECT tag, sort_order FROM tag_features ORDER BY sort_order ASC, tag ASC')
      .all();
    const counts = new Map(popular.map((item) => [item.tag, item.n]));
    const featuredSet = new Set(featured.map((item) => item.tag));

    const list = featured.map((item) => ({
      tag: item.tag,
      n: counts.get(item.tag) || 0,
      featured: true,
    }));
    for (const item of popular) {
      if (!featuredSet.has(item.tag)) list.push({ tag: item.tag, n: item.n, featured: false });
    }

    return { tags: list.slice(0, 20) };
  });

  // ---------------- 收藏 ----------------

  router.get('/api/me/bookmarks', async (ctx) => {
    const user = requireUser(ctx.user);
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);
    const rows = listBookmarkedThreads(user.id, perPage, offset);
    const total = countBookmarkedThreads(user.id);
    return {
      threads: rows.map((row) => threadOut(row, { withSnippet: false })),
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  /** 我赞过的楼层 */
  router.get('/api/me/likes', async (ctx) => {
    const user = requireUser(ctx.user);
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);

    const rows = db
      .prepare(
        `SELECT p.id AS post_id, p.thread_id, p.floor, p.content, p.created_at,
                pl.created_at AS liked_at,
                t.title AS thread_title,
                b.slug AS board_slug, b.name AS board_name,
                a.id AS author_id, a.username AS author_username,
                a.display_name AS author_display_name, a.avatar AS author_avatar
           FROM post_likes pl
           JOIN posts p ON p.id = pl.post_id
           JOIN threads t ON t.id = p.thread_id
           JOIN boards b ON b.id = t.board_id
           LEFT JOIN users a ON a.id = p.author_id
          WHERE pl.user_id = ? AND p.deleted = 0 AND t.deleted = 0
          ORDER BY pl.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(user.id, perPage, offset);

    const total = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM post_likes pl
           JOIN posts p ON p.id = pl.post_id
           JOIN threads t ON t.id = p.thread_id
          WHERE pl.user_id = ? AND p.deleted = 0 AND t.deleted = 0`,
      )
      .get(user.id).n;

    return {
      likes: rows.map((row) => ({
        post_id: row.post_id,
        thread_id: row.thread_id,
        floor: row.floor,
        thread_title: row.thread_title,
        board: { slug: row.board_slug, name: row.board_name },
        snippet: snippetOf(row.content, 120),
        liked_at: row.liked_at,
        post_created_at: row.created_at,
        author: row.author_id
          ? {
              id: row.author_id,
              username: row.author_username,
              display_name: row.author_display_name || row.author_username,
              avatar: row.author_avatar || '',
            }
          : null,
      })),
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  router.post('/api/threads/:id/bookmark', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`bookmark:${user.id}`, 200, 10 * 60 * 1000, '收藏太频繁');
    const thread = db.prepare('SELECT id, deleted FROM threads WHERE id = ?').get(Number(ctx.params.id));
    if (!thread || thread.deleted) throw notFound('主题不存在');

    const existing = db
      .prepare('SELECT 1 AS hit FROM bookmarks WHERE user_id = ? AND thread_id = ?')
      .get(user.id, thread.id);
    const body = await ctx.json().catch(() => ({}));
    const want = body.bookmarked === undefined ? !existing : !!body.bookmarked;

    if (want && !existing) {
      db.prepare('INSERT INTO bookmarks (user_id, thread_id, created_at) VALUES (?, ?, ?)').run(
        user.id,
        thread.id,
        now(),
      );
    } else if (!want && existing) {
      db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND thread_id = ?').run(user.id, thread.id);
    }

    return { bookmarked: want };
  });

  // ---------------- 资源收藏（启动器在线资源） ----------------

  const VALID_CONTENT_SOURCES = new Set(['curseforge', 'modrinth']);
  const CONTENT_META_MAX = 8 * 1024;

  /** 校验并规整一条资源收藏（单个上报 / 批量补传共用） */
  function normalizeContentFavorite(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('收藏条目格式不正确');
    const source = text(raw.source, { field: '资源来源', max: 32 });
    if (!VALID_CONTENT_SOURCES.has(source)) throw badRequest('资源来源无效');
    const remoteId = text(raw.remote_id, { field: '资源 ID', max: 64 });
    const contentType = text(raw.content_type, { field: '资源类型', max: 32, optional: true });
    let meta = raw.meta;
    if (meta === undefined || meta === null || meta === '') meta = {};
    if (typeof meta !== 'object' || Array.isArray(meta)) throw badRequest('资源信息格式不正确');
    const metaText = JSON.stringify(meta);
    if (metaText.length > CONTENT_META_MAX) throw badRequest('资源信息过大');
    return { source, remoteId, contentType, metaText };
  }

  /** 启动器在线资源收藏列表 */
  router.get('/api/me/content-favorites', async (ctx) => {
    const user = requireUser(ctx.user);
    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);
    const rows = db
      .prepare(
        `SELECT source, remote_id, content_type, meta, created_at
           FROM content_favorites
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(user.id, perPage, offset);
    const total = db
      .prepare('SELECT COUNT(*) AS n FROM content_favorites WHERE user_id = ?')
      .get(user.id).n;
    return {
      items: rows.map((row) => {
        let meta;
        try {
          meta = JSON.parse(row.meta || '{}');
        } catch {
          meta = {};
        }
        return { ...row, meta };
      }),
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  /** 收藏一个在线资源（已存在则刷新内容） */
  router.post('/api/me/content-favorites', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`content-fav:${user.id}`, 200, 10 * 60 * 1000, '收藏太频繁');
    const body = await ctx.json().catch(() => ({}));
    const item = normalizeContentFavorite(body);
    db.prepare(
      `INSERT INTO content_favorites (user_id, source, remote_id, content_type, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, source, remote_id)
       DO UPDATE SET content_type = excluded.content_type, meta = excluded.meta`,
    ).run(user.id, item.source, item.remoteId, item.contentType, item.metaText, now());
    return { ok: true };
  });

  /** 取消收藏一个在线资源 */
  router.delete('/api/me/content-favorites/:source/:remoteId', async (ctx) => {
    const user = requireUser(ctx.user);
    const result = db
      .prepare('DELETE FROM content_favorites WHERE user_id = ? AND source = ? AND remote_id = ?')
      .run(user.id, ctx.params.source, ctx.params.remoteId);
    if (result.changes === 0) throw notFound('该资源不在收藏中');
    return { ok: true };
  });

  /** 批量补传（登录后对账：只插入云端缺失的，返回新增数） */
  router.post('/api/me/content-favorites/bulk', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`content-fav-bulk:${user.id}`, 20, 10 * 60 * 1000, '同步太频繁');
    const body = await ctx.json().catch(() => ({}));
    if (!Array.isArray(body.items) || body.items.length === 0) return { added: 0 };
    if (body.items.length > 200) throw badRequest('单次最多补传 200 条');
    const normalized = body.items.map(normalizeContentFavorite);
    const exists = db.prepare(
      'SELECT 1 AS hit FROM content_favorites WHERE user_id = ? AND source = ? AND remote_id = ?',
    );
    const insert = db.prepare(
      `INSERT INTO content_favorites (user_id, source, remote_id, content_type, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    transaction(() => {
      for (const item of normalized) {
        if (exists.get(user.id, item.source, item.remoteId)) continue;
        insert.run(user.id, item.source, item.remoteId, item.contentType, item.metaText, now());
        added += 1;
      }
    });
    return { added };
  });

  router.post('/api/posts/:id/like', async (ctx) => {
    const user = requireUser(ctx.user);
    enforce(`like:${user.id}`, 200, 10 * 60 * 1000, '点赞太频繁');
    const post = db.prepare('SELECT id, deleted FROM posts WHERE id = ?').get(Number(ctx.params.id));
    if (!post || post.deleted) throw notFound('楼层不存在');

    const existing = db
      .prepare('SELECT 1 AS hit FROM post_likes WHERE user_id = ? AND post_id = ?')
      .get(user.id, post.id);
    const body = await ctx.json().catch(() => ({}));
    const want = body.like === undefined ? !existing : !!body.like;

    if (want && !existing) {
      db.prepare('INSERT INTO post_likes (user_id, post_id, created_at) VALUES (?, ?, ?)').run(
        user.id,
        post.id,
        now(),
      );
    } else if (!want && existing) {
      db.prepare('DELETE FROM post_likes WHERE user_id = ? AND post_id = ?').run(user.id, post.id);
    }

    const likes = db.prepare('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?').get(post.id).n;
    return { liked: want, likes };
  });

  // ---------------- 主题详情 ----------------

  router.get('/api/threads/:id', async (ctx) => {
    const threadId = Number(ctx.params.id);
    if (!Number.isInteger(threadId) || threadId <= 0) throw notFound('主题不存在');

    const thread = getThread(threadId);
    if (!thread || thread.deleted) throw notFound('主题不存在或已被删除');

    // 浏览量：同一 IP 对同一主题 10 分钟内只记一次
    const viewKey = `${ctx.ip}:${threadId}`;
    const lastSeen = viewSeen.get(viewKey) || 0;
    if (Date.now() - lastSeen > 10 * 60 * 1000) {
      viewSeen.set(viewKey, Date.now());
      db.prepare('UPDATE threads SET views = views + 1 WHERE id = ?').run(threadId);
      thread.views += 1;
      if (viewSeen.size > 5000) viewSeen.clear();
    }

    const { page, perPage, offset } = paginate(ctx.url.searchParams, 20);
    const rows = listPosts(threadId, perPage, offset);
    const total = countPosts(threadId);

    // 楼中楼：一次取出这些顶层楼层下的所有子楼层
    const parentIds = rows.map((row) => row.id);
    const children = listChildPosts(parentIds);
    const childrenByParent = new Map();
    for (const child of children) {
      const list = childrenByParent.get(child.parent_post_id) || [];
      list.push(child);
      childrenByParent.set(child.parent_post_id, list);
    }

    const allPostIds = [...parentIds, ...children.map((child) => child.id)];
    const liked = likedPostIds(ctx.user?.id, allPostIds);
    const bookmarked = ctx.user
      ? !!db.prepare('SELECT 1 AS hit FROM bookmarks WHERE user_id = ? AND thread_id = ?').get(ctx.user.id, threadId)
      : false;

    const detail = threadOut(thread, { withSnippet: false });
    detail.bookmarked = bookmarked;

    const posts = rows.map((row) => {
      const item = postOut({ ...row, liked: liked.has(row.id) });
      const children = childrenByParent.get(row.id) || [];
      item.children = children.map((child) => postOut({ ...child, liked: liked.has(child.id) }));
      item.children_count = children.filter((child) => !child.deleted).length;
      return item;
    });

    return {
      thread: detail,
      posts,
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  // ---------------- 发帖 ----------------

  router.post('/api/threads', async (ctx) => {
    const user = assertCanPost(ctx.user, 'thread');
    enforce(`thread:${user.id}`, 6, 60 * 60 * 1000, '发帖太频繁');
    enforce(`thread-ip:${ctx.ip}`, 12, 60 * 60 * 1000, '发帖太频繁');

    const body = await ctx.json();
    const board = body.board
      ? boardBySlug(String(body.board)) || boardById(Number(body.board))
      : boardBySlug('general');
    if (!board) throw badRequest('板块不存在');

    const title = text(body.title, { field: '标题', min: 2, max: 80 });
    const content = text(body.content, { field: '正文', min: 2, max: 20000 });
    // 违禁词：标题和正文一起查，命中就拦下这帖，普通玩家还会被自动禁言
    guardBannedWords(user, `${title}\n${content}`, { action: '发帖' });
    const tags = parseTags(body.tags);
    const timestamp = now();

    // 插件帖：带 plugin_upload_id 就把该上传绑定到这条主题（一帖一个，仅发帖时）。
    // 上传必须是本人、是插件类别、且还没绑给别的主题（防复用同一个包刷多个帖子）。
    let pluginUpload = null;
    const rawUploadId = body.plugin_upload_id;
    if (rawUploadId !== undefined && rawUploadId !== null && rawUploadId !== '') {
      const uploadId = Number(rawUploadId);
      if (!Number.isInteger(uploadId) || uploadId <= 0) throw badRequest('插件上传记录不正确');
      const upload = db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(uploadId, user.id);
      if (!upload || upload.deleted) throw notFound('插件上传不存在，请重新上传');
      if (upload.kind !== 'plugin') throw badRequest('该上传不是插件包', 'not_plugin_upload');
      const taken = db.prepare('SELECT thread_id FROM thread_plugins WHERE upload_id = ?').get(uploadId);
      if (taken) throw badRequest('这个插件包已经绑定在一条主题上了', 'plugin_upload_taken');
      let meta = {};
      try {
        meta = JSON.parse(upload.meta || '{}');
      } catch {
        meta = {};
      }
      pluginUpload = {
        id: upload.id,
        size: upload.size,
        plugin_id: meta.plugin_id,
        plugin_name: meta.plugin_name,
        plugin_version: meta.plugin_version,
        plugin_author: meta.plugin_author,
        plugin_description: meta.plugin_description,
        plugin_icon: meta.plugin_icon,
        file_hash: meta.file_hash,
      };
      if (!pluginUpload.plugin_id || !pluginUpload.plugin_name) {
        throw badRequest('插件上传缺少清单信息，请重新上传', 'plugin_meta_missing');
      }
    }

    const created = transaction(() => {
      const inserted = db
        .prepare(
          `INSERT INTO threads (board_id, author_id, title, created_at, last_post_at, last_post_user_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(board.id, user.id, title, timestamp, timestamp, user.id);
      const id = Number(inserted.lastInsertRowid);
      const firstPost = db
        .prepare(
          `INSERT INTO posts (thread_id, author_id, floor, content, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(id, user.id, content, timestamp, timestamp);
      if (pluginUpload) {
        db.prepare(
          `INSERT INTO thread_plugins
             (thread_id, upload_id, plugin_id, name, version, author, description, icon, file_size, file_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          pluginUpload.id,
          pluginUpload.plugin_id || '',
          pluginUpload.plugin_name || '',
          pluginUpload.plugin_version || '',
          pluginUpload.plugin_author || '',
          pluginUpload.plugin_description || '',
          pluginUpload.plugin_icon || '',
          pluginUpload.size || 0,
          pluginUpload.file_hash || '',
          timestamp,
        );
      }
      saveTags(id, tags);
      db.prepare('UPDATE users SET thread_count = thread_count + 1, post_count = post_count + 1 WHERE id = ?').run(
        user.id,
      );
      refreshBoardCounts(board.id);
      return { threadId: id, postId: Number(firstPost.lastInsertRowid) };
    });

    indexThread(created.threadId);
    safeNotify({
      thread: { id: created.threadId, author_id: user.id, title },
      post: { id: created.postId, content },
      actor: user,
    });
    return { thread: threadOut(getThread(created.threadId)), id: created.threadId };
  });

  // ---------------- 插件帖：软件端插件列表 ----------------
  // 把所有插件帖按时间倒序聚成一份「插件列表」，给启动器资源页的插件子页用。
  // 只对启动器 UA 开放（网页端不提供这个列表，浏览插件仍走普通帖子）。

  router.get('/api/forum-plugins', async (ctx) => {
    if (!/BlockBoxLauncher/i.test(ctx.userAgent || '')) {
      throw forbidden('插件列表只在方块盒子软件端提供');
    }

    const { page, perPage, offset } = paginate(ctx.url.searchParams, 24, 60);
    const sort = ['latest', 'hot', 'downloads'].includes(ctx.url.searchParams.get('sort') || '')
      ? ctx.url.searchParams.get('sort')
      : 'latest';

    const orderBy = {
      latest: 't.last_post_at DESC',
      hot: '(t.reply_count * 4 + t.views) DESC',
      downloads: 'tp.downloads DESC',
    }[sort];

    const total = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM thread_plugins tp
           JOIN threads t ON t.id = tp.thread_id
          WHERE t.deleted = 0`,
      )
      .get().n;

    const rows = db
      .prepare(
        `SELECT tp.id, tp.upload_id, tp.plugin_id, tp.name, tp.version, tp.author,
                tp.description, tp.icon, tp.file_size, tp.downloads,
                t.id AS thread_id, t.views, t.reply_count, t.created_at, t.last_post_at,
                u.id AS author_id, u.username AS author_username,
                u.display_name AS author_display_name, u.avatar AS author_avatar
           FROM thread_plugins tp
           JOIN threads t ON t.id = tp.thread_id
           LEFT JOIN users u ON u.id = t.author_id
          WHERE t.deleted = 0
          ORDER BY ${orderBy}
          LIMIT ? OFFSET ?`,
      )
      .all(perPage, offset);

    return {
      plugins: rows.map((row) => ({
        id: row.id,
        upload_id: row.upload_id,
        plugin_id: row.plugin_id,
        thread_id: row.thread_id,
        name: row.name,
        version: row.version || '',
        author: row.author || '',
        description: row.description || '',
        icon: row.icon || '',
        file_size: row.file_size || 0,
        downloads: row.downloads || 0,
        views: row.views || 0,
        reply_count: row.reply_count || 0,
        created_at: row.created_at,
        posted_by: row.author_id
          ? { id: row.author_id, username: row.author_username, display_name: row.author_display_name || row.author_username, avatar: row.author_avatar || '' }
          : null,
      })),
      pagination: { page, per_page: perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
    };
  });

  // ---------------- 插件帖：下载地址 ----------------
  // 返回插件包的下载 URL（配置了 CDN 时是 CDN 域名，否则论坛自己发）。
  // 匿名也能拿（人机门禁已在上层把住），拿到地址后客户端直接去下载字节。

  router.get('/api/threads/:id/plugin/download', async (ctx) => {
    const threadId = Number(ctx.params.id);
    if (!Number.isInteger(threadId) || threadId <= 0) throw notFound('主题不存在');
    const thread = db.prepare('SELECT id, deleted FROM threads WHERE id = ?').get(threadId);
    if (!thread || thread.deleted) throw notFound('主题不存在或已被删除');

    const plugin = db
      .prepare(
        `SELECT tp.id, tp.downloads, u.url, u.size
           FROM thread_plugins tp
           JOIN uploads u ON u.id = tp.upload_id AND u.deleted = 0
          WHERE tp.thread_id = ?`,
      )
      .get(threadId);
    if (!plugin) throw notFound('这条主题没有挂插件');

    // 计数用内存桶去抖：同一 IP 同一插件 10 分钟内只记一次，防刷新
    const key = `${ctx.ip}:${plugin.id}`;
    const lastSeen = pluginDownloadSeen.get(key) || 0;
    if (Date.now() - lastSeen > 10 * 60 * 1000) {
      pluginDownloadSeen.set(key, Date.now());
      db.prepare('UPDATE thread_plugins SET downloads = downloads + 1 WHERE id = ?').run(plugin.id);
      if (pluginDownloadSeen.size > 5000) pluginDownloadSeen.clear();
    }

    const [, pathname] = plugin.url.match(/^\/uploads\/(.+)$/) || [];
    const url = pathname ? `${cdnBase || config.publicOrigin || ''}/uploads/${pathname}` : plugin.url;
    return {
      url,
      size: plugin.size || 0,
      content_type: 'application/octet-stream',
      filename: pathname || 'plugin.BlockBox',
      downloads: plugin.downloads,
    };
  });

  // ---------------- 修改主题 ----------------

  router.patch('/api/threads/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const thread = getThread(Number(ctx.params.id));
    if (!thread || thread.deleted) throw notFound('主题不存在');
    if (thread.author_id !== user.id && !isAdminRole(user.role)) throw badRequest('只能修改自己的主题');

    const body = await ctx.json();
    const title = body.title === undefined ? thread.title : text(body.title, { field: '标题', min: 2, max: 80 });
    // 改标题也要过违禁词；只改标签、标题没动时不再查一遍
    if (title !== thread.title) guardBannedWords(user, title, { action: '修改标题' });
    db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, thread.id);
    if (body.tags !== undefined) saveTags(thread.id, parseTags(body.tags));
    indexThread(thread.id);
    return { thread: threadOut(getThread(thread.id)) };
  });

  router.delete('/api/threads/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const thread = getThread(Number(ctx.params.id));
    if (!thread || thread.deleted) throw notFound('主题不存在');
    if (thread.author_id !== user.id && !isAdminRole(user.role)) throw badRequest('只能删除自己的主题');
    db.prepare('UPDATE threads SET deleted = 1 WHERE id = ?').run(thread.id);
    // 插件帖删了,包也别再让人下(同步软删 uploads 记录,下载接口会查它)
    db.prepare(
      `UPDATE uploads SET deleted = 1
        WHERE deleted = 0 AND kind = 'plugin'
          AND id IN (SELECT upload_id FROM thread_plugins WHERE thread_id = ?)`,
    ).run(thread.id);
    db.prepare('DELETE FROM thread_search WHERE thread_id = ?').run(thread.id);
    db.prepare('DELETE FROM notifications WHERE thread_id = ?').run(thread.id);
    db.prepare("UPDATE reports SET status = 'ignored' WHERE thread_id = ? AND status = 'open'").run(thread.id);
    refreshBoardCounts(thread.board_id);
    return { ok: true };
  });

  // ---------------- 回复 ----------------

  router.post('/api/threads/:id/posts', async (ctx) => {
    const user = assertCanPost(ctx.user, 'reply');
    enforce(`reply:${user.id}`, 12, 5 * 60 * 1000, '回复太频繁');
    enforce(`reply-ip:${ctx.ip}`, 20, 5 * 60 * 1000, '回复太频繁');

    const thread = getThread(Number(ctx.params.id));
    if (!thread || thread.deleted) throw notFound('主题不存在或已被删除');
    if (thread.locked && !isAdminRole(user.role)) throw badRequest('该主题已被锁定，无法回复', 'thread_locked');

    const body = await ctx.json();
    const content = text(body.content, { field: '回复内容', min: 1, max: 20000 });
    guardBannedWords(user, content, { action: '回复' });

    // 楼中楼：指定回复哪一层；如果回复的是别人的楼中楼，挂到同一个父楼层下（保持两层结构）
    let parentPostId = null;
    let replyToAuthorId = null;
    if (body.reply_to !== undefined && body.reply_to !== null && body.reply_to !== '') {
      const targetId = Number(body.reply_to);
      const target = db
        .prepare('SELECT id, thread_id, author_id, parent_post_id, deleted FROM posts WHERE id = ?')
        .get(targetId);
      if (!target || target.thread_id !== thread.id || target.deleted) {
        throw badRequest('要回复的楼层不存在', 'bad_reply_target');
      }
      parentPostId = target.parent_post_id || target.id;
      replyToAuthorId = target.author_id;
    }

    const timestamp = now();

    const postId = transaction(() => {
      const maxFloor = db.prepare('SELECT COALESCE(MAX(floor), 0) AS f FROM posts WHERE thread_id = ?').get(thread.id).f;
      const inserted = db
        .prepare(
          `INSERT INTO posts (thread_id, author_id, floor, parent_post_id, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(thread.id, user.id, maxFloor + 1, parentPostId, content, timestamp, timestamp);
      db.prepare(
        `UPDATE threads SET reply_count = reply_count + 1, last_post_at = ?, last_post_user_id = ? WHERE id = ?`,
      ).run(timestamp, user.id, thread.id);
      db.prepare('UPDATE users SET post_count = post_count + 1 WHERE id = ?').run(user.id);
      refreshBoardCounts(thread.board_id);
      return Number(inserted.lastInsertRowid);
    });

    addSearchEntry(thread.id, content);
    const row = db
      .prepare(
        `SELECT p.*, u.username, u.display_name, u.avatar, u.role, u.status,
                u.thread_count AS u_thread_count, u.post_count AS u_post_count,
                u.created_at AS u_created_at,
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count
           FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
      )
      .get(postId);
    safeNotify({
      thread: { id: thread.id, author_id: thread.author_id, title: thread.title },
      post: { id: postId, content },
      actor: user,
      parentPostAuthorId: replyToAuthorId,
    });
    return { post: postOut(row), thread_id: thread.id };
  });

  // ---------------- 修改 / 删除楼层 ----------------

  router.patch('/api/posts/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(ctx.params.id));
    if (!post || post.deleted) throw notFound('楼层不存在');
    if (post.author_id !== user.id && !isAdminRole(user.role)) throw badRequest('只能修改自己的回复');

    const body = await ctx.json();
    const content = text(body.content, { field: '内容', min: 1, max: 20000 });
    // 编辑后的内容也要过违禁词；内容没变就不再查一遍
    if (content !== post.content) guardBannedWords(user, content, { action: '修改回复' });
    db.prepare('UPDATE posts SET content = ?, updated_at = ?, edit_count = edit_count + 1 WHERE id = ?').run(
      content,
      now(),
      post.id,
    );
    indexThread(post.thread_id);
    const row = db
      .prepare(
        `SELECT p.*, u.username, u.display_name, u.avatar, u.role, u.status,
                u.thread_count AS u_thread_count, u.post_count AS u_post_count,
                u.created_at AS u_created_at
           FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
      )
      .get(post.id);
    return { post: postOut(row) };
  });

  router.delete('/api/posts/:id', async (ctx) => {
    const user = requireUser(ctx.user);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(ctx.params.id));
    if (!post || post.deleted) throw notFound('楼层不存在');
    if (post.author_id !== user.id && !isAdminRole(user.role)) throw badRequest('只能删除自己的回复');

    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(post.thread_id);
    transaction(() => {
      db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?').run(post.id);
      db.prepare('UPDATE threads SET reply_count = MAX(0, reply_count - 1) WHERE id = ?').run(post.thread_id);
      db.prepare('DELETE FROM notifications WHERE post_id = ?').run(post.id);
      db.prepare("UPDATE reports SET status = 'ignored' WHERE post_id = ? AND status = 'open'").run(post.id);
      if (thread) refreshBoardCounts(thread.board_id);
    });
    indexThread(post.thread_id);
    return { ok: true };
  });

  // ---------------- 管理：板块 ----------------

  router.post('/api/admin/boards', async (ctx) => {
    requireAdmin(ctx.user);
    const body = await ctx.json();
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!VALID_SLUG.test(slug)) throw badRequest('板块标识只能用小写字母、数字和短横线（2–31 位）');
    if (boardBySlug(slug)) throw badRequest('这个板块标识已存在');
    const name = text(body.name, { field: '板块名称', min: 1, max: 20 });
    const description = text(body.description, { field: '板块简介', max: 120, optional: true });
    const icon = text(body.icon, { field: '图标', max: 8, optional: true }) || '💬';
    const sortOrder = Number(body.sort_order ?? 100);

    const result = db
      .prepare(
        'INSERT INTO boards (slug, name, description, icon, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(slug, name, description, icon, Number.isFinite(sortOrder) ? Math.floor(sortOrder) : 100, now());
    return { board: boardOut(boardById(Number(result.lastInsertRowid))) };
  });

  router.patch('/api/admin/boards/:id', async (ctx) => {
    requireAdmin(ctx.user);
    const board = boardById(Number(ctx.params.id));
    if (!board) throw notFound('板块不存在');
    const body = await ctx.json();
    const name = body.name === undefined ? board.name : text(body.name, { field: '板块名称', min: 1, max: 20 });
    const description =
      body.description === undefined
        ? board.description
        : text(body.description, { field: '板块简介', max: 120, optional: true });
    const icon = body.icon === undefined ? board.icon : text(body.icon, { field: '图标', max: 8, optional: true }) || '💬';
    const sortOrder = body.sort_order === undefined ? board.sort_order : Number(body.sort_order);
    db.prepare('UPDATE boards SET name = ?, description = ?, icon = ?, sort_order = ? WHERE id = ?').run(
      name,
      description,
      icon,
      Number.isFinite(sortOrder) ? Math.floor(sortOrder) : board.sort_order,
      board.id,
    );
    return { board: boardOut(boardById(board.id)) };
  });

  router.delete('/api/admin/boards/:id', async (ctx) => {
    requireAdmin(ctx.user);
    const board = boardById(Number(ctx.params.id));
    if (!board) throw notFound('板块不存在');
    const threads = db.prepare('SELECT COUNT(*) AS n FROM threads WHERE board_id = ?').get(board.id).n;
    if (threads > 0) throw badRequest('板块里还有主题，先把主题移走或删除');
    db.prepare('DELETE FROM boards WHERE id = ?').run(board.id);
    return { ok: true };
  });

  // ---------------- 管理：主题置顶 / 锁定 / 换板块 ----------------

  router.patch('/api/admin/threads/:id', async (ctx) => {
    requireAdmin(ctx.user);
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(Number(ctx.params.id));
    if (!thread) throw notFound('主题不存在');
    const body = await ctx.json();

    let boardId = thread.board_id;
    if (body.board !== undefined) {
      const target = boardBySlug(String(body.board)) || boardById(Number(body.board));
      if (!target) throw badRequest('目标板块不存在');
      boardId = target.id;
    }
    const pinned = body.pinned === undefined ? thread.pinned : bool(body.pinned, { field: 'pinned' }) ? 1 : 0;
    const locked = body.locked === undefined ? thread.locked : bool(body.locked, { field: 'locked' }) ? 1 : 0;

    db.prepare('UPDATE threads SET pinned = ?, locked = ?, board_id = ? WHERE id = ?').run(
      pinned,
      locked,
      boardId,
      thread.id,
    );
    refreshBoardCounts(thread.board_id);
    if (boardId !== thread.board_id) refreshBoardCounts(boardId);
    indexThread(thread.id);
    return { thread: threadOut(getThread(thread.id)) };
  });
}
