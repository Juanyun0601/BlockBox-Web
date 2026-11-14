/**
 * 服务端渲染（给搜索引擎与链接预览机器人）。
 *
 * 论坛页面原本是纯前端渲染：爬虫不会执行脚本，滑块门禁又把它们拦在
 * 门外，所以论坛内容一直进不了搜索收录。这里给爬虫准备一套「同一地址、
 * 服务端直接吐 HTML」的只读页面：
 *
 *   /                        首页：板块一览 + 最新主题
 *   /board.html?slug=<slug>  板块页：板块介绍 + 主题列表（前 10 页）
 *   /thread.html?id=<id>     主题页：标题、正文、回复与插件卡片
 *   /sitemap.xml             论坛自己的站点地图（首页 + 板块 + 最近主题）
 *
 * 真人访问同一批地址仍走原来的滑块门禁 + 前端应用，互不影响；
 * 机器人 UA 的判断在 crawler.js。所有数据都从本地 SQLite 直读，
 * 不走 API、不计浏览量。
 */
import { config } from '../config.js';
import { db, now } from '../db.js';
import {
  countThreads,
  getThread,
  listChildPosts,
  listPosts,
  listThreads,
} from './queries.js';

/** 主题页最多渲染多少个顶层楼层 */
const MAX_POSTS = 100;
/** 单个楼层正文最多渲染多少字（超出截断，足够搜索引擎理解内容） */
const MAX_POST_CHARS = 2000;
/** 板块页给爬虫最多翻多少页 */
const MAX_BOARD_PAGES = 10;
/** sitemap 最多列出多少条主题 */
const SITEMAP_MAX_THREADS = 1000;

/**
 * 站点绝对地址：canonical、sitemap 都要它。
 * 本地开发常把 PUBLIC_ORIGIN 填成 127.0.0.1，那类值不能进正式页面。
 */
const SITE_ORIGIN =
  config.publicOrigin && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(config.publicOrigin)
    ? config.publicOrigin
    : 'https://forum.mcblockbox.top';

// ---------------------------------------------------------------- 小工具

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 秒级时间戳 → YYYY-MM-DD（sitemap 用） */
function dayOf(seconds) {
  const value = Number(seconds) || 0;
  if (!value) return '';
  const d = new Date(value * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 秒级时间戳 → 「2026-11-14 20:31」 */
function timeOf(seconds) {
  const value = Number(seconds) || 0;
  if (!value) return '';
  const d = new Date(value * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dayOf(value)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Markdown → 纯文本：图片/链接/记号剥掉，代码块保留内容。
 * 搜索引擎要的是文字，排版不重要。
 */
function mdToText(source) {
  return String(source || '')
    .replace(/```[a-zA-Z0-9_-]*\r?\n/g, '\n')
    .replace(/```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '［图片］')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\r/g, '');
}

/** 纯文本 → 段落 HTML（空行分段，单行换行用 <br>；超出 maxChars 先截文本再渲染） */
function paragraphsHtml(source, maxChars = 0) {
  let text = mdToText(source);
  if (maxChars > 0 && text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${esc(part).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function threadUrl(id) {
  return `${SITE_ORIGIN}/thread.html?id=${Number(id)}`;
}

function boardUrl(slug) {
  return `${SITE_ORIGIN}/board.html?slug=${encodeURIComponent(String(slug || ''))}`;
}

// ---------------------------------------------------------------- 数据

function listBoards() {
  return db
    .prepare(
      `SELECT b.id, b.slug, b.name, b.description,
              (SELECT COUNT(*) FROM threads t WHERE t.board_id = b.id AND t.deleted = 0) AS thread_count
         FROM boards b
        ORDER BY b.sort_order ASC, b.id ASC`,
    )
    .all();
}

function boardBySlug(slug) {
  return db.prepare('SELECT id, slug, name, description FROM boards WHERE slug = ?').get(String(slug || ''));
}

// ---------------------------------------------------------------- 页面骨架

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 16px 48px; background: #fbfdfb; color: #17251a;
  font: 15px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
}
.wrap { max-width: 780px; margin: 0 auto; }
header.site { padding: 20px 0 8px; border-bottom: 1px solid #e3ece2; margin-bottom: 26px; }
header.site a { color: #2e7d32; font-weight: 700; text-decoration: none; font-size: 16px; }
header.site span { color: #87998b; font-size: 13px; margin-left: 10px; }
h1 { font-size: 26px; line-height: 1.3; margin: 18px 0 8px; letter-spacing: -.01em; }
h2 { font-size: 19px; margin: 30px 0 12px; }
p.lead { color: #55685a; margin: 0 0 8px; }
.meta { color: #87998b; font-size: 13px; margin: 0 0 18px; }
.meta a { color: #388e3c; text-decoration: none; }
.card { background: #fff; border: 1px solid #e3ece2; border-radius: 12px; padding: 14px 18px; margin: 12px 0; }
ul.list { list-style: none; margin: 0; padding: 0; }
ul.list li { padding: 10px 2px; border-top: 1px dashed #e3ece2; }
ul.list li:first-child { border-top: 0; }
ul.list a { color: #17251a; font-weight: 600; text-decoration: none; font-size: 15.5px; }
ul.list a:hover { color: #2e7d32; }
.small { color: #87998b; font-size: 12.5px; }
.content p { margin: 10px 0; overflow-wrap: break-word; }
.reply { border-left: 3px solid #e8f5e9; padding: 2px 0 2px 14px; margin: 16px 0; }
.reply .who { font-size: 13px; color: #55685a; margin: 0 0 4px; }
.plugin { border-color: #a5d6a7; background: #f2f8f1; }
.plugin h3 { margin: 2px 0 6px; font-size: 16px; }
.pager { margin: 22px 0; display: flex; gap: 8px; flex-wrap: wrap; }
.pager a { color: #2e7d32; text-decoration: none; border: 1px solid #e3ece2; background: #fff; border-radius: 8px; padding: 5px 12px; font-size: 13.5px; }
footer.site { margin-top: 40px; color: #87998b; font-size: 12.5px; border-top: 1px solid #e3ece2; padding-top: 14px; }
footer.site a { color: #388e3c; text-decoration: none; }
`.trim();

function layout({ title, description, canonical, body, jsonLd = null, robots = null }) {
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    robots ? `<meta name="robots" content="${esc(robots)}">` : '<meta name="robots" content="index,follow">',
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    '<link rel="icon" href="/assets/img/icon.ico">',
  ].join('\n');
  const ld = jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
${head}
<style>${STYLE}</style>
${ld}
</head>
<body>
<div class="wrap">
<header class="site"><a href="${SITE_ORIGIN}/">方块盒子论坛</a><span>方块盒子官方玩家社区</span></header>
${body}
<footer class="site">方块盒子 —— 现代开源免费的 Minecraft（我的世界）启动器。官网：<a href="https://mcblockbox.top/">mcblockbox.top</a></footer>
</div>
</body>
</html>`;
}

function breadcrumb(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      ...(item.url ? { item: item.url } : {}),
    })),
  };
}

// ---------------------------------------------------------------- 页面

/** 首页：板块一览 + 最新主题 */
function renderHomePage() {
  const boards = listBoards();
  const threads = listThreads({ sort: 'latest', limit: 20, offset: 0 });
  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM threads WHERE deleted = 0) AS threads,
              (SELECT COUNT(*) FROM posts WHERE deleted = 0) AS posts`,
    )
    .get();

  const boardHtml = boards
    .map(
      (board) => `<li>
  <a href="${boardUrl(board.slug)}">${esc(board.name)}</a>
  <div class="small">${esc(board.description || '')} · ${board.thread_count} 条主题</div>
</li>`,
    )
    .join('\n');

  const threadHtml = threads
    .map(
      (row) => `<li>
  <a href="${threadUrl(row.id)}">${esc(row.title)}</a>
  <div class="small">${esc(row.board_name)} · ${esc(row.author_display_name || row.author_username || '')} · ${dayOf(row.last_post_at || row.created_at)} · 回复 ${row.reply_count || 0}${row.tp_id ? ' · 插件分享' : ''}</div>
</li>`,
    )
    .join('\n');

  const description = `${config.siteDesc || '方块盒子官方玩家社区'}。现有 ${stats.threads} 条主题、${stats.posts} 条回复：使用求助、玩法分享、插件分享与开发、建议反馈。`;

  const body = `
<h1>方块盒子论坛</h1>
<p class="lead">${esc(description)}</p>
<h2>讨论板块</h2>
<ul class="list">
${boardHtml}
</ul>
<h2>最新主题</h2>
<ul class="list">
${threadHtml}
</ul>`;

  return layout({
    title: '方块盒子论坛 — Minecraft（我的世界）启动器官方社区',
    description,
    canonical: `${SITE_ORIGIN}/`,
    body,
    jsonLd: breadcrumb([{ name: '首页', url: `${SITE_ORIGIN}/` }]),
  });
}

/** 板块页：介绍 + 主题列表（给爬虫翻前 10 页） */
function renderBoardPage(params) {
  const slug = String(params.get('slug') || '').trim();
  const board = boardBySlug(slug);
  if (!board) return null;

  const page = Math.min(MAX_BOARD_PAGES, Math.max(1, Number(params.get('page') || 1) || 1));
  const perPage = 25;
  const rows = listThreads({ boardId: board.id, sort: 'latest', limit: perPage, offset: (page - 1) * perPage });
  const total = countThreads({ boardId: board.id });
  const pages = Math.min(MAX_BOARD_PAGES, Math.max(1, Math.ceil(total / perPage)));

  const items = rows
    .map(
      (row) => `<li>
  <a href="${threadUrl(row.id)}">${esc(row.title)}</a>
  <div class="small">${esc(row.author_display_name || row.author_username || '')} · ${dayOf(row.last_post_at || row.created_at)} · 回复 ${row.reply_count || 0} · 浏览 ${row.views || 0}${row.tp_id ? ' · 插件分享' : ''}</div>
</li>`,
    )
    .join('\n');

  const pager =
    pages > 1
      ? `<div class="pager">${Array.from({ length: pages }, (_, i) => {
          const n = i + 1;
          const href = n === 1 ? boardUrl(board.slug) : `${boardUrl(board.slug)}&amp;page=${n}`;
          return n === page
            ? `<span>第 ${n} 页</span>`
            : `<a href="${esc(href)}">第 ${n} 页</a>`;
        }).join('')}</div>`
      : '';

  const canonical = page > 1 ? `${SITE_ORIGIN}/board.html?slug=${encodeURIComponent(board.slug)}&page=${page}` : boardUrl(board.slug);
  const body = `
<p class="meta"><a href="${SITE_ORIGIN}/">首页</a> › ${esc(board.name)}</p>
<h1>${esc(board.name)}</h1>
${board.description ? `<p class="lead">${esc(board.description)}</p>` : ''}
<p class="meta">共 ${total} 条主题</p>
<ul class="list">
${items || '<li><div class="small">这个板块还没有主题。</div></li>'}
</ul>
${pager}`;

  return layout({
    title: `${board.name} · 方块盒子论坛`,
    description: `${board.name}：${board.description || '方块盒子论坛讨论板块'}。共 ${total} 条主题，欢迎加入讨论。`,
    canonical,
    body,
    jsonLd: breadcrumb([
      { name: '首页', url: `${SITE_ORIGIN}/` },
      { name: board.name, url: boardUrl(board.slug) },
    ]),
  });
}

/** 主题页：标题、正文、回复与插件卡片 */
function renderThreadPage(params) {
  const id = Number(params.get('id'));
  if (!Number.isInteger(id) || id <= 0) return null;
  const thread = getThread(id);
  if (!thread || thread.deleted) return null;

  const rows = listPosts(id, MAX_POSTS, 0);
  const children = listChildPosts(rows.map((row) => row.id));
  const childrenByParent = new Map();
  for (const child of children) {
    const list = childrenByParent.get(child.parent_post_id) || [];
    list.push(child);
    childrenByParent.set(child.parent_post_id, list);
  }

  const author = thread.author_display_name || thread.author_username || '';
  const meta = [
    `<a href="${boardUrl(thread.board_slug)}">${esc(thread.board_name)}</a>`,
    `作者 ${esc(author)}`,
    `发布于 ${timeOf(thread.created_at)}`,
    `回复 ${thread.reply_count || 0}`,
    `浏览 ${thread.views || 0}`,
  ].join(' · ');

  let pluginCard = '';
  if (thread.tp_id) {
    pluginCard = `<div class="card plugin">
  <h3>插件：${esc(thread.tp_name || thread.title)}</h3>
  <div class="small">版本 ${esc(thread.tp_version || '—')} · 作者 ${esc(thread.tp_author || author)} · 下载 ${thread.tp_downloads || 0} 次</div>
  ${thread.tp_description ? `<p>${esc(mdToText(thread.tp_description)).slice(0, 600)}</p>` : ''}
  <p class="small">在方块盒子启动器的「资源 → 插件」里搜索「${esc(thread.tp_name || thread.title)}」即可下载安装。</p>
</div>`;
  }

  const firstPost = rows.find((row) => row.floor === 1) || rows[0];
  const mainHtml = firstPost ? paragraphsHtml(firstPost.content, MAX_POST_CHARS) : '';

  const replies = rows
    .filter((row) => row.floor > 1 && !row.deleted)
    .map((row) => {
      const kids = (childrenByParent.get(row.id) || []).filter((child) => !child.deleted);
      return `<div class="reply">
  <p class="who">${row.floor}楼 · ${esc(row.display_name || row.username || '')} · ${timeOf(row.created_at)}</p>
  <div class="content">${paragraphsHtml(row.content, MAX_POST_CHARS)}</div>
  ${kids
    .map(
      (child) => `<div class="reply">
  <p class="who">${esc(child.display_name || child.username || '')} · ${timeOf(child.created_at)}</p>
  <div class="content">${paragraphsHtml(child.content, MAX_POST_CHARS)}</div>
</div>`,
    )
    .join('\n')}
</div>`;
    })
    .join('\n');

  const firstPostText = mdToText(firstPost?.content || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  const description = `${firstPostText || thread.title}（${thread.board_name}，${author} 发布，回复 ${thread.reply_count || 0}）`;

  const body = `
<p class="meta"><a href="${SITE_ORIGIN}/">首页</a> › <a href="${boardUrl(thread.board_slug)}">${esc(thread.board_name)}</a></p>
<h1>${esc(thread.title)}</h1>
<p class="meta">${meta}</p>
${pluginCard}
<div class="content">
${mainHtml}
</div>
<h2>回复（${thread.reply_count || 0}）</h2>
${replies || '<p class="small">还没有回复。</p>'}`;

  return layout({
    title: `${thread.title} · 方块盒子论坛`,
    description,
    canonical: threadUrl(id),
    body,
    jsonLd: breadcrumb([
      { name: '首页', url: `${SITE_ORIGIN}/` },
      { name: thread.board_name, url: boardUrl(thread.board_slug) },
      { name: thread.title, url: threadUrl(id) },
    ]),
  });
}

/** 404：给爬虫看的简化版错误页（noindex） */
function renderNotFoundPage() {
  return layout({
    title: '页面不存在 · 方块盒子论坛',
    description: '请求的页面不存在或已被删除。',
    canonical: `${SITE_ORIGIN}/404.html`,
    robots: 'noindex',
    body: `<h1>页面不存在</h1><p class="lead">内容可能已被删除或移动，<a href="${SITE_ORIGIN}/">回论坛首页</a>看看其他讨论。</p>`,
  });
}

// ---------------------------------------------------------------- 对外入口

/**
 * 爬虫请求的页面渲染。
 * @returns {{ status: number, type: string, body: string } | null} null 表示这个地址没有对应
 *   的服务端渲染页（调用方按原逻辑继续走门禁 / 静态文件）。
 */
export function renderCrawlerPage(pathname, searchParams) {
  try {
    switch (pathname) {
      case '/':
      case '/index.html':
        return { status: 200, type: 'text/html; charset=utf-8', body: renderHomePage() };
      case '/board.html': {
        const body = renderBoardPage(searchParams);
        return body ? { status: 200, type: 'text/html; charset=utf-8', body } : { status: 404, type: 'text/html; charset=utf-8', body: renderNotFoundPage() };
      }
      case '/thread.html': {
        const body = renderThreadPage(searchParams);
        return body ? { status: 200, type: 'text/html; charset=utf-8', body } : { status: 404, type: 'text/html; charset=utf-8', body: renderNotFoundPage() };
      }
      default:
        return null;
    }
  } catch (error) {
    console.error('[论坛] 爬虫页面渲染失败：', pathname, error);
    return null;
  }
}

/** 论坛自己的 sitemap.xml：首页 + 板块 + 最近主题（带 lastmod） */
export function renderSitemapXml() {
  const boards = listBoards();
  const threads = db
    .prepare(
      `SELECT id, COALESCE(last_post_at, created_at) AS lastmod
         FROM threads WHERE deleted = 0
        ORDER BY COALESCE(last_post_at, created_at) DESC
        LIMIT ${SITEMAP_MAX_THREADS}`,
    )
    .all();
  const today = dayOf(now());

  const entries = [
    `  <url><loc>${SITE_ORIGIN}/</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    ...boards.map(
      (board) =>
        `  <url><loc>${boardUrl(board.slug)}</loc><changefreq>hourly</changefreq><priority>0.8</priority></url>`,
    ),
    ...threads.map(
      (thread) =>
        `  <url><loc>${threadUrl(thread.id)}</loc><lastmod>${dayOf(thread.lastmod) || today}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>`,
    ),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;
}
