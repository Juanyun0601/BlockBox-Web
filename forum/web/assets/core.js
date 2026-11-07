/* 方块盒子论坛 · 前端公共库（零依赖）
   包含：接口请求、登录状态、顶栏、时间/数字格式化、头像、Markdown 渲染、分页、提示条 */
(function () {
  'use strict';

  const BB = {};
  BB.state = { me: null, site: { name: '方块盒子论坛', desc: '' }, unread: 0, friendUnread: 0 };

  // ------------------------------------------------------------ 基础工具

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  BB.esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

  // ------------------------------------------------------------ 公开资源 / CDN

  // 服务端配了 CDN 时会在页面里注入这个域名，/assets、/uploads 就改从 CDN 加载；
  // 没配就是空串，所有地址原样使用。接口返回的仍然是站内相对路径，
  // 这样换 CDN 域名、甚至以后接对象存储，都不用动数据库里的老内容。
  const CDN_BASE = String((window && window.__BBF_CDN__) || '').replace(/\/+$/, '');
  const PUBLIC_PREFIXES = ['/assets/', '/uploads/'];

  /** 站内公开资源走 CDN；外链、接口地址等原样返回 */
  BB.media = (url) => {
    if (!CDN_BASE || !url) return url;
    const value = String(url);
    if (!PUBLIC_PREFIXES.some((prefix) => value.startsWith(prefix))) return value;
    return CDN_BASE + value;
  };

  /** 去掉 CDN 域名，还原成站内路径（算缩略图、判断是不是站内图片时用） */
  const withoutCdn = (url) => {
    const value = String(url == null ? '' : url);
    return CDN_BASE && value.startsWith(CDN_BASE) ? value.slice(CDN_BASE.length) : value;
  };

  BB.param = (name) => new URLSearchParams(location.search).get(name);

  BB.num = (value) => {
    const n = Number(value || 0);
    if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  const pad = (n) => String(n).padStart(2, '0');

  BB.time = (seconds) => {
    if (!seconds) return '';
    const diff = Date.now() / 1000 - Number(seconds);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
    const d = new Date(Number(seconds) * 1000);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return `${sameYear ? '' : `${d.getFullYear()}-`}${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  BB.datetime = (seconds) => {
    if (!seconds) return '';
    const d = new Date(Number(seconds) * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // ------------------------------------------------------------ 禁言
  // scope 存库格式：all 或 thread,reply,dm 这样的列表
  BB.MUTE_SCOPES = [
    ['thread', '发帖'],
    ['reply', '回复'],
    ['dm', '私信'],
  ];

  BB.muteScopeList = (scope) => {
    const raw = String(scope == null ? '' : scope).trim().toLowerCase();
    if (!raw || raw === 'all') return BB.MUTE_SCOPES.map(([key]) => key);
    const picked = raw.split(/[,\s]+/);
    return BB.MUTE_SCOPES.map(([key]) => key).filter((key) => picked.includes(key));
  };

  BB.muteScopeLabel = (scope) => {
    const list = BB.muteScopeList(scope);
    const labels = BB.MUTE_SCOPES.filter(([key]) => list.includes(key)).map(([, label]) => label);
    return labels.length === BB.MUTE_SCOPES.length ? '全部发言' : labels.join('、') || '全部发言';
  };

  /** 禁言到期说法：永久 / 还剩 x 天 / 至 某时 */
  BB.muteUntilText = (until) => {
    const seconds = Number(until || 0);
    if (!seconds) return '永久';
    const diff = seconds - Date.now() / 1000;
    if (diff <= 0) return '即将自动解除';
    if (diff < 3600) return `还剩 ${Math.max(1, Math.ceil(diff / 60))} 分钟`;
    if (diff < 86400) return `还剩 ${Math.ceil(diff / 3600)} 小时`;
    if (diff < 86400 * 30) return `还剩 ${Math.ceil(diff / 86400)} 天`;
    return `${BB.datetime(seconds)} 解除`;
  };

  // ------------------------------------------------------------ 接口

  BB.api = async function (path, options = {}) {
    const { method = 'GET', body, raw, headers = {} } = options;
    const init = { method, headers: { accept: 'application/json', ...headers }, credentials: 'same-origin' };
    if (body !== undefined) {
      if (raw) {
        init.body = body;
      } else {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    const res = await fetch(path, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      const error = new Error((data && (data.error || data.message)) || `请求失败（${res.status}）`);
      error.status = res.status;
      error.code = data && data.code;
      // 人机验证没过：统一送去验证页，验完再回到当前页面
      if (error.code === 'human_required' && !BB.state.humanRedirect) {
        BB.state.humanRedirect = true;
        const target = location.pathname + location.search;
        location.replace(`/verify.html?next=${encodeURIComponent(target)}`);
      }
      throw error;
    }
    return data;
  };

  // ------------------------------------------------------------ 提示条

  BB.toast = (message, kind = '') => {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    const node = document.createElement('div');
    node.className = `toast${kind ? ` toast-${kind}` : ''}`;
    node.textContent = message;
    stack.appendChild(node);
    setTimeout(() => node.remove(), 2600);
  };

  // ------------------------------------------------------------ 头像

  // 默认头像的配色：只用绿色系，和官网主题保持一致
  const AVATAR_HUES = [138, 160, 122, 172, 105, 150, 88, 145];

  function hueOf(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 997;
    return AVATAR_HUES[hash % AVATAR_HUES.length];
  }

  BB.avatar = (user, sizeClass = '') => {
    const cls = `avatar${sizeClass ? ` ${sizeClass}` : ''}`;
    if (!user) return `<span class="${cls}" style="background:#9bb39d">?</span>`;
    const name = user.display_name || user.username || '?';
    if (user.avatar) {
      return `<span class="${cls}"><img src="${BB.esc(BB.media(user.avatar))}" alt="${BB.esc(name)}" loading="lazy"></span>`;
    }
    const initial = [...String(name)][0] || '?';
    const hue = hueOf(user.username || name);
    return `<span class="${cls}" style="background:hsl(${hue} 42% 44%)">${BB.esc(initial)}</span>`;
  };

  // ------------------------------------------------------------ Markdown

  const safeUrl = (url) => /^(https?:\/\/|\/[^/\s])/.test(url);

  /** 站内图片的缩略图地址（服务端缺失时会自动回退到原图），原图和缩略图都走 CDN */
  const thumbFor = (url) => {
    const relative = withoutCdn(url);
    if (!relative.startsWith('/uploads/') || relative.startsWith('/uploads/thumbs/')) return url;
    return BB.media(`/uploads/thumbs/${relative.slice('/uploads/'.length)}`);
  };

  BB.thumbFor = thumbFor;

  function inline(raw) {
    let text = BB.esc(raw);
    const codes = [];
    text = text.replace(/`([^`\n]+)`/g, (match, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, url) => {
      if (!safeUrl(url)) return match;
      const full = BB.media(url);
      return `<a class="img-link" href="${full}" data-full="${full}"><img src="${thumbFor(url)}" alt="${alt}" loading="lazy"></a>`;
    });
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) =>
      safeUrl(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>` : match,
    );
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<"']+)/g, (match, pre, url) => {
      return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`;
    });
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    text = text.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(
      /(^|[^\w@])@([A-Za-z0-9_\u4e00-\u9fa5-]{2,20})/g,
      '$1<span class="mention">@$2</span>',
    );
    text = text.replace(/\u0000(\d+)\u0000/g, (match, index) => `<code>${codes[Number(index)]}</code>`);
    return text;
  }

  BB.md = function (source) {
    const lines = String(source == null ? '' : source).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let paragraph = [];
    let listType = null;

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push(`<p>${paragraph.join('<br>')}</p>`);
        paragraph = [];
      }
    };
    const closeList = () => {
      if (listType) {
        out.push(`</${listType}>`);
        listType = null;
      }
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      if (/^\s*```/.test(line)) {
        flushParagraph();
        closeList();
        const lang = line.trim().slice(3).trim();
        const buffer = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buffer.push(lines[i]);
          i += 1;
        }
        out.push(
          `<pre><code${lang ? ` class="lang-${BB.esc(lang)}"` : ''}>${BB.esc(buffer.join('\n'))}</code></pre>`,
        );
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }

      if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
        flushParagraph();
        closeList();
        out.push('<hr>');
        continue;
      }

      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        closeList();
        const level = Math.min(6, heading[1].length + 1);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }

      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph();
        closeList();
        const buffer = [quote[1]];
        while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) {
          i += 1;
          buffer.push(lines[i].replace(/^>\s?/, ''));
        }
        out.push(`<blockquote>${buffer.map(inline).join('<br>')}</blockquote>`);
        continue;
      }

      const bullet = /^[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        if (listType !== 'ul') {
          closeList();
          out.push('<ul>');
          listType = 'ul';
        }
        out.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }

      const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
      if (ordered) {
        flushParagraph();
        if (listType !== 'ol') {
          closeList();
          out.push('<ol>');
          listType = 'ol';
        }
        out.push(`<li>${inline(ordered[1])}</li>`);
        continue;
      }

      closeList();
      paragraph.push(inline(line));
    }

    flushParagraph();
    closeList();
    return out.join('\n');
  };

  // ------------------------------------------------------------ 分页

  BB.pagination = function (pagination, hrefFor) {
    if (!pagination || pagination.pages <= 1) return '';
    const current = pagination.page;
    const pages = pagination.pages;
    const parts = [];

    if (current > 1) parts.push(`<a href="${BB.esc(hrefFor(current - 1))}">上一页</a>`);

    const from = Math.max(1, current - 2);
    const to = Math.min(pages, current + 2);
    if (from > 1) {
      parts.push(`<a href="${BB.esc(hrefFor(1))}">1</a>`);
      if (from > 2) parts.push('<span class="disabled">…</span>');
    }
    for (let page = from; page <= to; page += 1) {
      if (page === current) parts.push(`<span class="current">${page}</span>`);
      else parts.push(`<a href="${BB.esc(hrefFor(page))}">${page}</a>`);
    }
    if (to < pages) {
      if (to < pages - 1) parts.push('<span class="disabled">…</span>');
      parts.push(`<a href="${BB.esc(hrefFor(pages))}">${pages}</a>`);
    }

    if (current < pages) parts.push(`<a href="${BB.esc(hrefFor(current + 1))}">下一页</a>`);
    return `<div class="pagination">${parts.join('')}</div>`;
  };

  // ------------------------------------------------------------ 登录状态

  BB.isLoggedIn = () => !!BB.state.me;
  BB.isAdmin = () => !!BB.state.me && (BB.state.me.role === 'admin' || BB.state.me.role === 'moderator');
  // 真管理员：次级管理员做不了的事（比如给人设管理权限）要挡住
  BB.isHeadAdmin = () => !!BB.state.me && BB.state.me.role === 'admin';

  BB.loginLink = (next) =>
    `/login.html?next=${encodeURIComponent(next || location.pathname + location.search)}`;

  BB.requireLogin = () => {
    if (BB.state.me) return BB.state.me;
    location.href = BB.loginLink();
    throw new Error('未登录，正在跳转登录页');
  };

  // ------------------------------------------------------------ 顶栏

  const CUBE_SVG =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 2.6 21 7.4v9.2L12 21.4 3 16.6V7.4z"/><path d="m3 7.4 9 4.8 9-4.8"/><path d="M12 12.2v9.2"/></svg>';

  function themeButton() {
    const dark = document.documentElement.dataset.theme === 'dark';
    return `<button class="icon-btn" id="themeToggle" title="切换深色模式" aria-label="切换深色模式">${
      dark
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>'
    }</button>`;
  }

  /** 顶栏「好友」入口上的未读角标（未读私信 + 待处理申请） */
  function friendBadge() {
    const n = Number(BB.state.friendUnread || 0);
    return n > 0 ? `<span class="badge" id="navFriendBadge">${n > 99 ? '99+' : n}</span>` : '';
  }

  function renderNav(active) {
    const host = document.getElementById('siteNav');
    if (!host) return;
    const me = BB.state.me;
    const is = (key) => (active === key ? ' class="active"' : '');

    const actions = me
      ? `<a class="btn btn-primary" href="/new.html">发帖</a>
         <a class="icon-btn nav-bell" href="/notifications.html" title="站内通知" aria-label="站内通知">
           <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
           ${BB.state.unread > 0 ? `<span class="badge">${BB.state.unread > 99 ? '99+' : BB.state.unread}</span>` : ''}
         </a>
         <a class="nav-user" href="/user.html?id=${me.id}" title="${BB.esc(me.display_name || me.username)}">
           ${BB.avatar(me, 'avatar-sm')}<span class="nav-username">${BB.esc(me.display_name || me.username)}</span>
         </a>
         <button class="icon-btn" id="logoutBtn" title="退出登录" aria-label="退出登录">
           <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>
         </button>`
      : `<a class="btn btn-ghost" href="/login.html">登录</a>
         <a class="btn btn-primary" href="/login.html?tab=register">注册</a>`;

    host.innerHTML = `
      <div class="topbar">
        <div class="wrap topbar-inner">
          <a class="brand" href="/">
            <span class="brand-mark">${CUBE_SVG}</span>
            <span class="brand-text">方块盒子<small>论坛</small></span>
          </a>
          <nav class="nav-links" aria-label="主导航">
            <a href="/" data-nav="home"${is('home')}>首页</a>
            <a href="/#boards" data-nav="boards"${is('boards')}>板块</a>
            <a href="/lobby.html" data-nav="lobby"${is('lobby')}>联机大厅</a>
            <a href="/search.html" data-nav="search"${is('search')}>搜索</a>
            ${me ? `<a href="/friends.html" data-nav="friends" id="navFriendLink"${is('friends')}>好友${friendBadge()}</a>` : ''}
            ${BB.isAdmin() ? `<a href="/admin.html" data-nav="admin"${is('admin')}>管理</a>` : ''}
          </nav>
          <form class="nav-search" id="navSearch" role="search">
            <input type="search" name="q" placeholder="搜索帖子…" aria-label="搜索帖子">
          </form>
          <div class="nav-actions">
            ${themeButton()}
            ${actions}
          </div>
        </div>
      </div>`;

    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem('bbf-theme', next);
        } catch {
          /* 隐私模式忽略 */
        }
        renderNav(active);
      });
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        try {
          await BB.api('/api/auth/logout', { method: 'POST' });
        } catch {
          /* 无论成功与否都按退出处理 */
        }
        BB.state.me = null;
        location.href = '/';
      });
    }

    const searchForm = document.getElementById('navSearch');
    if (searchForm) {
      searchForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = new FormData(searchForm).get('q') || '';
        const query = String(value).trim();
        location.href = query ? `/search.html?q=${encodeURIComponent(query)}` : '/search.html';
      });
    }
  }

  // ------------------------------------------------------------ 启动

  BB.boot = async function (init) {
    try {
      const data = await BB.api('/api/me');
      BB.state.me = data.user;
      BB.state.unread = Number(data.unread || 0);
      BB.state.friendUnread = Number(data.friend_unread || 0);
      BB.state.site = data.site || BB.state.site;
    } catch (error) {
      BB.toast('无法连接论坛服务，请确认服务已启动', 'error');
    }

    const page = document.body.dataset.page || '';
    renderNav(page);
    BB.syncFriendNav();
    BB.initLightbox();

    // 登录后每 30 秒刷新一次好友角标；好友页自己有更快的轮询，两边写同一个状态不冲突
    if (BB.state.me) {
      let badgeBusy = false;
      setInterval(async () => {
        if (document.hidden || badgeBusy || !BB.state.me) return;
        badgeBusy = true;
        try {
          const data = await BB.api('/api/messages/poll');
          BB.state.friendUnread =
            Number(data.total_unread || 0) + Number(data.incoming_requests || 0);
          BB.syncFriendNav();
        } catch {
          /* 网络抖动忽略，等下一轮 */
        } finally {
          badgeBusy = false;
        }
      }, 30000);
    }

    const footer = document.getElementById('siteFooter');
    if (footer) {
      footer.innerHTML = `
        <div class="wrap footer-inner">
          <span>© ${new Date().getFullYear()} 方块盒子 · 官方玩家社区</span>
          <div class="links">
            <a href="https://mcblockbox.top" target="_blank" rel="noopener">官网</a>
            <a href="/search.html">搜索</a>
            <a href="/feedback.html">反馈</a>
            <a href="https://mcblockbox.top/docs.html" target="_blank" rel="noopener">开发文档</a>
          </div>
        </div>`;
    }

    if (typeof init === 'function') {
      try {
        await init(BB.state);
      } catch (error) {
        if (error && error.status === 401) {
          location.href = BB.loginLink();
          return;
        }
        console.error(error);
        BB.toast(error.message || '页面加载失败', 'error');
      }
    }
  };

  /** 统一的表单错误展示 */
  BB.showError = (host, message) => {
    if (!host) return;
    host.innerHTML = message ? `<div class="form-error">${BB.esc(message)}</div>` : '';
  };

  BB.boardTag = (board) =>
    board ? `<a class="board-tag" href="/board.html?slug=${encodeURIComponent(board.slug)}">${BB.esc(board.name)}</a>` : '';

  /** 列表里的一行主题（首页 / 板块页 / 搜索页 / 用户页共用） */
  BB.threadRow = (thread, { showBoard = true, showSnippet = false } = {}) => {
    const badges = [
      thread.pinned ? '<span class="chip chip-warn">置顶</span>' : '',
      thread.locked ? '<span class="chip chip-grey">已锁定</span>' : '',
    ]
      .filter(Boolean)
      .join('');

    const authorName = thread.author
      ? thread.author.display_name || thread.author.username
      : '未知用户';

    const meta = [
      showBoard ? BB.boardTag(thread.board) : '',
      `<span>${BB.esc(authorName)}</span>`,
      `<span>${BB.time(thread.last_post_at || thread.created_at)}</span>`,
      showSnippet && thread.snippet
        ? `<span class="thread-snippet">${BB.esc(thread.snippet)}</span>`
        : '',
    ]
      .filter(Boolean)
      .join('<span class="dot">·</span>');

    const tags = (thread.tags || [])
      .slice(0, 3)
      .map((tag) => `<a class="tag" href="/search.html?q=${encodeURIComponent('#' + tag)}">#${BB.esc(tag)}</a>`)
      .join('');

    return `<div class="thread-row${showSnippet ? ' with-snippet' : ''}">
      ${BB.avatar(thread.author, 'avatar-sm')}
      <div class="thread-main">
        <div class="thread-title">
          <a class="row-link" href="/thread.html?id=${thread.id}">${BB.esc(thread.title)}</a>${badges}
        </div>
        <div class="thread-meta">${tags}${tags ? '<span class="dot">·</span>' : ''}${meta}</div>
      </div>
      <div class="thread-counts">
        <div><b>${BB.num(thread.reply_count)}</b><span>回复</span></div>
        <div><b>${BB.num(thread.views)}</b><span>浏览</span></div>
      </div>
    </div>`;
  };

  // ------------------------------------------------------------ 图片上传 / 草稿 / 举报

  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    const position = start + text.length;
    textarea.selectionStart = position;
    textarea.selectionEnd = position;
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  BB.insertAtCursor = insertAtCursor;

  /** 上传一张图片到站内图床，返回可直接放进 Markdown 的地址 */
  BB.uploadImage = async (file) => {
    const data = await BB.api('/api/upload', {
      method: 'POST',
      raw: true,
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    return data.url;
  };

  /**
   * 给输入框挂上"粘贴截图 / 拖拽图片自动上传"能力。
   * onInsert 不传时按光标位置插入 Markdown。
   */
  BB.attachImagePaste = (textarea, { onInsert } = {}) => {
    const handleFiles = async (files) => {
      for (const file of files) {
        if (!file.type || !file.type.startsWith('image/')) continue;
        if (file.size > 4 * 1024 * 1024) {
          BB.toast('图片超过 4 MB，先压缩一下吧', 'error');
          continue;
        }
        BB.toast('正在上传图片…');
        try {
          const url = await BB.uploadImage(file);
          const snippet = `\n![${file.name || '图片'}](${url})\n`;
          if (typeof onInsert === 'function') onInsert(snippet);
          else insertAtCursor(textarea, snippet);
          BB.toast('图片已插入正文', 'ok');
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      }
    };

    textarea.addEventListener('paste', (event) => {
      const files = Array.from((event.clipboardData && event.clipboardData.files) || []).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (files.length > 0) {
        event.preventDefault();
        handleFiles(files);
      }
    });
    textarea.addEventListener('dragover', (event) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
        event.preventDefault();
      }
    });
    textarea.addEventListener('drop', (event) => {
      const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (files.length > 0) {
        event.preventDefault();
        handleFiles(files);
      }
    });
    return handleFiles;
  };

  /** 草稿：存 localStorage，按页面 / 主题区分 */
  BB.draft = {
    key: (name) => `bbf-draft:${name}`,
    save(name, content) {
      try {
        if (content && content.trim()) localStorage.setItem(this.key(name), content);
        else localStorage.removeItem(this.key(name));
      } catch {
        /* 隐私模式写不进去，忽略 */
      }
    },
    load(name) {
      try {
        return localStorage.getItem(this.key(name)) || '';
      } catch {
        return '';
      }
    },
    clear(name) {
      try {
        localStorage.removeItem(this.key(name));
      } catch {
        /* ignore */
      }
    },
  };

  /** 输入框自动保存草稿，并在打开时恢复未发完的内容 */
  BB.bindDraft = (textarea, name, { restore = true } = {}) => {
    if (restore) {
      const saved = BB.draft.load(name);
      if (saved && !textarea.value.trim()) {
        textarea.value = saved;
        BB.toast('已恢复上次没发完的草稿');
      }
    }
    let timer = null;
    textarea.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => BB.draft.save(name, textarea.value), 600);
    });
  };

  BB.markAllRead = async () => {
    try {
      await BB.api('/api/notifications/read', { method: 'POST', body: {} });
    } catch {
      /* 失败也不影响阅读 */
    }
    BB.state.unread = 0;
    BB.refreshNav();
  };

  BB.reportPost = async (postId) => {
    if (!BB.state.me) {
      location.href = BB.loginLink();
      return;
    }
    const reason = prompt('举报理由（例如：广告、人身攻击、刷屏）', '');
    if (reason === null) return;
    try {
      await BB.api('/api/reports', { method: 'POST', body: { post_id: postId, reason } });
      BB.toast('已提交举报，管理员会尽快处理', 'ok');
    } catch (error) {
      BB.toast(error.message, 'error');
    }
  };

  // ------------------------------------------------------------ Markdown 编辑器增强

  /** 把选区替换为文本并走原生撤销栈；execCommand 不可用时手动改 value */
  function replaceSelection(textarea, text, selectFrom, selectTo) {
    let ok = false;
    textarea.focus();
    try {
      ok = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }
    if (!ok) {
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    }
    if (selectFrom != null) {
      textarea.selectionStart = selectFrom;
      textarea.selectionEnd = selectTo == null ? selectFrom : selectTo;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** 光标覆盖的整行范围（行首到行尾） */
  function lineRange(textarea) {
    const value = textarea.value;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    return { start: lineStart, end: lineEnd };
  }

  /** 光标是否在 ``` 围栏代码块内 */
  function insideFence(value, position) {
    const lines = value.slice(0, position).split('\n');
    let fences = 0;
    for (const line of lines) if (/^\s*```/.test(line)) fences += 1;
    return fences % 2 === 1;
  }

  /** 用包裹符包住选区（已包住时反向拆掉），插入后选中包裹内容方便继续打字 */
  function wrapSelection(textarea, marker, placeholder) {
    const value = textarea.value;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    let inner = value.slice(start, end);
    const before = value.slice(Math.max(0, start - marker.length), start);
    const after = value.slice(end, end + marker.length);
    if (inner && before === marker && after === marker) {
      textarea.setSelectionRange(start - marker.length, end + marker.length);
      replaceSelection(textarea, inner, start - marker.length, end - marker.length);
      return;
    }
    if (!inner) inner = placeholder;
    const text = marker + inner + marker;
    const innerStart = start + marker.length;
    textarea.setSelectionRange(start, end);
    replaceSelection(textarea, text, innerStart, innerStart + inner.length);
  }

  /** 对选区覆盖的每一行做加/去前缀的开关式转换 */
  function toggleLinePrefix(textarea, pattern, makePrefix) {
    const { start, end } = lineRange(textarea);
    const lines = textarea.value.slice(start, end).split('\n');
    const marked = lines.filter((line) => line.trim());
    const allMarked = marked.length > 0 && marked.every((line) => pattern.test(line));
    const changed = lines
      .map((line, index) => {
        const stripped = line.replace(pattern, '');
        if (allMarked) return stripped;
        return line.trim() ? makePrefix(line, index) : line;
      })
      .join('\n');
    textarea.setSelectionRange(start, end);
    replaceSelection(textarea, changed, start, start + changed.length);
  }

  const HEADING_RE = /^#{1,6}\s+/;
  const QUOTE_RE = /^>\s?/;
  const UL_RE = /^\s*[-*+]\s+/;
  const OL_RE = /^\s*\d+[.)]\s+/;

  const lineCommands = {
    heading: (textarea) =>
      toggleLinePrefix(
        textarea,
        HEADING_RE,
        (line) => `## ${line.replace(HEADING_RE, '')}`,
      ),
    quote: (textarea) => toggleLinePrefix(textarea, QUOTE_RE, (line) => `> ${line.replace(QUOTE_RE, '')}`),
    ul: (textarea) => toggleLinePrefix(textarea, UL_RE, (line) => `- ${line.replace(UL_RE, '')}`),
    ol: (textarea) =>
      toggleLinePrefix(textarea, OL_RE, (line, index) => `${index + 1}. ${line.replace(OL_RE, '')}`),
  };

  function codeBlockCommand(textarea) {
    const { start, end } = lineRange(textarea);
    const block = textarea.value.slice(start, end);
    const text = `\`\`\`\n${block}${block ? '\n' : ''}\`\`\``;
    const caret = start + 4;
    textarea.setSelectionRange(start, end);
    replaceSelection(textarea, text, caret, caret + block.length);
  }

  function linkCommand(textarea) {
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const inner = textarea.value.slice(start, end).trim();
    if (inner && /^(https?:\/\/|\/)[^\s)]+$/i.test(inner)) {
      // 选中的是链接：包成 [标题](链接)，选中标题让用户填
      const text = `[](${inner})`;
      replaceSelection(textarea, text, start + 1, start + 1);
    } else if (inner) {
      // 选中的是文字：包成 [文字](https://)，选中链接让用户填
      const urlStart = start + inner.length + 3;
      replaceSelection(textarea, `[${inner}](https://)`, urlStart, urlStart + 8);
    } else {
      replaceSelection(textarea, '[标题](https://)', start + 1, start + 3);
    }
  }

  /** 回车续列表：有编号时自增，空列表项回车直接退出 */
  function continueList(textarea) {
    if (textarea.selectionEnd !== textarea.selectionStart) return false;
    const caret = textarea.selectionStart ?? 0;
    const value = textarea.value;
    if (insideFence(value, caret)) return false;
    const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    const line = value.slice(lineStart, caret);
    const match = /^(\s*)([-*+]|\d+([.)]))\s+(.*)$/.exec(line);
    if (!match) return false;
    if (!match[4].trim()) {
      textarea.setSelectionRange(lineStart, caret);
      replaceSelection(textarea, '');
      return true;
    }
    const number = /^(\d+)([.)])$/.exec(match[2]);
    const marker = number ? `${Number(number[1]) + 1}${number[2]} ` : `${match[2]} `;
    replaceSelection(textarea, `\n${match[1]}${marker}`);
    return true;
  }

  /** 代码块内或选中多行时，Tab 缩进 / Shift+Tab 反缩进（2 空格） */
  function indentSelection(textarea, event) {
    const value = textarea.value;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const multiLine = value.slice(start, end).includes('\n');
    if (!multiLine && !insideFence(value, start)) return false;
    const { start: ls, end: le } = lineRange(textarea);
    const lines = value.slice(ls, le).split('\n');
    const changed = lines
      .map((line) => (event.shiftKey ? line.replace(/^( {1,2}|\t)/, '') : line ? `  ${line}` : line))
      .join('\n');
    textarea.setSelectionRange(ls, le);
    replaceSelection(textarea, changed, ls, ls + changed.length);
    return true;
  }

  /**
   * 给 textarea 挂上 Markdown 工具栏、编辑/预览切换和快捷键。
   * options.imageFiles 传 BB.attachImagePaste 的返回值，图片按钮就能复用粘贴上传通道。
   */
  BB.attachMarkdownEditor = (textarea, options = {}) => {
    if (textarea.dataset.mdEditor) return null;
    textarea.dataset.mdEditor = '1';

    const editor = document.createElement('div');
    editor.className = 'md-editor';

    const buttons = [
      ['bold', 'B', '加粗（Ctrl+B）', 'md-strong'],
      ['italic', 'I', '斜体（Ctrl+I）', 'md-em'],
      ['strike', 'S', '删除线', 'md-strike'],
      ['heading', 'H', '标题', ''],
      ['quote', '❝', '引用', ''],
      ['code', '</>', '行内代码', 'md-code'],
      ['codeblock', '{}', '代码块', 'md-code'],
      ['ul', '• 列表', '无序列表', ''],
      ['ol', '1. 编号', '有序列表', ''],
      ['link', '链接', '插入链接（Ctrl+K）', ''],
      ['image', '图片', '上传图片', ''],
    ];
    editor.innerHTML = `
      <div class="md-toolbar" role="toolbar" aria-label="Markdown 工具栏">
        ${buttons
          .map(
            ([cmd, label, title, extra]) =>
              `<button type="button" data-cmd="${cmd}" title="${title}" aria-label="${title}" class="${extra}">${BB.esc(
                label,
              )}</button>`,
          )
          .join('')}
        <span class="md-mode" role="tablist" aria-label="编辑或预览">
          <button type="button" data-mode="edit" class="active" aria-pressed="true">编辑</button>
          <button type="button" data-mode="preview" aria-pressed="false">预览</button>
        </span>
      </div>`;

    const preview = document.createElement('div');
    preview.className = 'md-preview post-content hidden';
    // 把 textarea 和预览层一起包进编辑器容器，工具栏/输入区/预览的间距由容器统一控制
    textarea.replaceWith(editor);
    editor.append(textarea, preview);

    // ---------- 图片 ----------
    const imageFiles =
      options.imageFiles ||
      (async (files) => {
        for (const file of Array.from(files)) {
          if (!file.type || !file.type.startsWith('image/')) continue;
          if (file.size > 4 * 1024 * 1024) {
            BB.toast('图片超过 4 MB，先压缩一下吧', 'error');
            continue;
          }
          BB.toast('正在上传图片…');
          try {
            const url = await BB.uploadImage(file);
            insertAtCursor(textarea, `\n![${file.name || '图片'}](${url})\n`);
            BB.toast('图片已插入正文', 'ok');
          } catch (error) {
            BB.toast(error.message, 'error');
          }
        }
      });
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/*';
    picker.multiple = true;
    picker.hidden = true;
    picker.addEventListener('change', () => {
      if (picker.files && picker.files.length) imageFiles(picker.files);
      picker.value = '';
    });
    editor.appendChild(picker);

    // ---------- 命令 ----------
    const commands = {
      bold: () => wrapSelection(textarea, '**', '加粗'),
      italic: () => wrapSelection(textarea, '*', '斜体'),
      strike: () => wrapSelection(textarea, '~~', '删除线'),
      code: () => wrapSelection(textarea, '`', '代码'),
      codeblock: () => codeBlockCommand(textarea),
      link: () => linkCommand(textarea),
      image: () => picker.click(),
      heading: () => lineCommands.heading(textarea),
      quote: () => lineCommands.quote(textarea),
      ul: () => lineCommands.ul(textarea),
      ol: () => lineCommands.ol(textarea),
    };

    const toolbar = editor.querySelector('.md-toolbar');
    toolbar.addEventListener('mousedown', (event) => {
      // 阻止工具栏抢焦点，保住 textarea 里的选区
      if (event.target.closest('button')) event.preventDefault();
    });
    toolbar.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-cmd]');
      if (!button) return;
      commands[button.dataset.cmd]();
    });

    // ---------- 编辑 / 预览 ----------
    const modeButtons = Array.from(editor.querySelectorAll('.md-mode button'));
    const setMode = (mode) => {
      const isPreview = mode === 'preview';
      modeButtons.forEach((button) => {
        const active = (button.dataset.mode === 'preview') === isPreview;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      if (isPreview) {
        preview.style.minHeight = `${textarea.offsetHeight}px`;
        preview.innerHTML = BB.md(textarea.value);
        textarea.style.display = 'none';
        preview.classList.remove('hidden');
      } else {
        preview.classList.add('hidden');
        preview.innerHTML = '';
        textarea.style.display = '';
        textarea.focus();
      }
    };
    modeButtons.forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));

    // ---------- 快捷键 / 智能输入 ----------
    textarea.addEventListener('keydown', (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && (event.key === 'b' || event.key === 'B')) {
        event.preventDefault();
        commands.bold();
        return;
      }
      if (mod && (event.key === 'i' || event.key === 'I')) {
        event.preventDefault();
        commands.italic();
        return;
      }
      if (mod && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        commands.link();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !mod) {
        // @选人菜单开着时让位给补全
        const menu = document.querySelector('.mention-menu');
        if (menu && !menu.classList.contains('hidden')) return;
        if (continueList(textarea)) event.preventDefault();
        return;
      }
      if (event.key === 'Tab' && indentSelection(textarea, event)) event.preventDefault();
    });

    return { setMode };
  };

  BB.refreshNav = () => renderNav(document.body.dataset.page || '');

  /** 只更新顶栏「好友」角标的数字，不重建整个导航（好友页轮询时用） */
  BB.syncFriendNav = () => {
    const link = document.getElementById('navFriendLink');
    if (!link) return;
    const n = Number(BB.state.friendUnread || 0);
    let badge = document.getElementById('navFriendBadge');
    if (n > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'badge';
        badge.id = 'navFriendBadge';
        link.appendChild(badge);
      }
      badge.textContent = n > 99 ? '99+' : String(n);
    } else if (badge) {
      badge.remove();
    }
  };

  // ------------------------------------------------------------ 图片灯箱

  BB.initLightbox = () => {
    if (document.getElementById('bbLightbox')) return;
    const box = document.createElement('div');
    box.id = 'bbLightbox';
    box.className = 'lightbox hidden';
    box.innerHTML = '<img alt="放大预览"><button type="button" class="lightbox-close" aria-label="关闭">×</button>';
    document.body.appendChild(box);
    const image = box.querySelector('img');

    const close = () => {
      box.classList.add('hidden');
      image.removeAttribute('src');
    };

    box.addEventListener('click', (event) => {
      if (event.target === box || event.target.classList.contains('lightbox-close')) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !box.classList.contains('hidden')) close();
    });
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a.img-link');
      if (!link) return;
      event.preventDefault();
      image.src = link.dataset.full || link.getAttribute('href');
      box.classList.remove('hidden');
    });
  };

  // ------------------------------------------------------------ @ 自动补全

  function caretCoordinates(textarea, position) {
    const computed = window.getComputedStyle(textarea);
    const mirror = document.createElement('div');
    const properties = [
      'fontFamily',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'letterSpacing',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'borderTopWidth',
      'borderRightWidth',
      'borderBottomWidth',
      'borderLeftWidth',
      'boxSizing',
    ];
    for (const property of properties) mirror.style[property] = computed[property];
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.top = '0';
    mirror.style.left = '-9999px';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.width = computed.width;
    mirror.textContent = textarea.value.slice(0, position);

    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);

    const rect = textarea.getBoundingClientRect();
    const coordinates = {
      top: rect.top + window.scrollY + marker.offsetTop - textarea.scrollTop + 22,
      left: rect.left + window.scrollX + marker.offsetLeft - textarea.scrollLeft,
    };
    mirror.remove();
    return coordinates;
  }

  /** 输入 @ 时弹出用户名候选，支持上下键选择 */
  BB.attachMentions = (textarea) => {
    const menu = document.createElement('div');
    menu.className = 'mention-menu hidden';
    document.body.appendChild(menu);

    let items = [];
    let active = 0;
    let tokenStart = -1;
    let timer = null;
    let requestId = 0;

    const hide = () => {
      menu.classList.add('hidden');
      items = [];
      active = 0;
      tokenStart = -1;
    };

    const apply = (user) => {
      if (tokenStart < 0) return;
      const caret = textarea.selectionStart ?? textarea.value.length;
      const before = textarea.value.slice(0, tokenStart);
      const after = textarea.value.slice(caret);
      const insert = `@${user.username} `;
      textarea.value = before + insert + after;
      const next = before.length + insert.length;
      textarea.selectionStart = next;
      textarea.selectionEnd = next;
      textarea.focus();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      hide();
    };

    const render = () => {
      if (items.length === 0) {
        hide();
        return;
      }
      menu.innerHTML = items
        .map(
          (user, index) =>
            `<button type="button" class="mention-item${index === active ? ' active' : ''}" data-index="${index}">
               ${BB.avatar(user, 'avatar-sm')}
               <span class="mention-name">${BB.esc(user.display_name || user.username)}</span>
               <span class="mention-login">@${BB.esc(user.username)}</span>
             </button>`,
        )
        .join('');
      menu.classList.remove('hidden');
      menu.querySelectorAll('.mention-item').forEach((button) => {
        button.addEventListener('mousedown', (event) => {
          event.preventDefault();
          apply(items[Number(button.dataset.index)]);
        });
      });
    };

    const lookup = async (query) => {
      const current = ++requestId;
      try {
        const data = await BB.api(`/api/users/search?q=${encodeURIComponent(query)}`);
        if (current !== requestId) return;
        items = data.users || [];
        active = 0;
        render();
        if (items.length > 0) {
          const position = caretCoordinates(textarea, tokenStart);
          menu.style.top = `${position.top}px`;
          menu.style.left = `${position.left}px`;
        }
      } catch {
        hide();
      }
    };

    const update = () => {
      const caret = textarea.selectionStart ?? textarea.value.length;
      const before = textarea.value.slice(0, caret);
      const match = /(?:^|[^\w@])@([A-Za-z0-9_\u4e00-\u9fa5-]{0,20})$/.exec(before);
      if (!match) {
        hide();
        return;
      }
      tokenStart = caret - match[1].length - 1;
      const query = match[1];
      clearTimeout(timer);
      timer = setTimeout(() => lookup(query), 140);
    };

    textarea.addEventListener('input', update);
    textarea.addEventListener('blur', () => setTimeout(hide, 150));
    textarea.addEventListener('keydown', (event) => {
      if (menu.classList.contains('hidden') || items.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        active = (active + 1) % items.length;
        render();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        active = (active - 1 + items.length) % items.length;
        render();
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        apply(items[active]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        hide();
      }
    });

    return { hide };
  };

  BB.likePost = async (postId) => {
    if (!BB.state.me) {
      location.href = BB.loginLink();
      return null;
    }
    try {
      return await BB.api(`/api/posts/${postId}/like`, { method: 'POST', body: {} });
    } catch (error) {
      BB.toast(error.message, 'error');
      return null;
    }
  };

  BB.toggleBookmark = async (threadId) => {
    if (!BB.state.me) {
      location.href = BB.loginLink();
      return null;
    }
    try {
      return await BB.api(`/api/threads/${threadId}/bookmark`, { method: 'POST', body: {} });
    } catch (error) {
      BB.toast(error.message, 'error');
      return null;
    }
  };

  // ------------------------------------------------------------ 图片裁剪

  /**
   * 弹出裁剪框：拖动平移、滑块 / 滚轮缩放，确认后导出指定比例的 PNG。
   * 取消时 resolve(null)。
   * 头像用方形（圆形参考线），个人主页封面用 3:1 的横框。
   */
  BB.cropImage = (file, options = {}) =>
    new Promise((resolve) => {
      const config = {
        aspect: 1,
        stageWidth: 320,
        outWidth: 256,
        round: false,
        title: '裁剪头像',
        hint: '拖动图片调整位置，滚轮或滑块缩放。',
        ...options,
      };
      // 手机窄屏上按可视宽度缩小舞台，避免裁剪框撑出屏幕
      const STAGE_W = Math.min(config.stageWidth, Math.max(240, Math.round(window.innerWidth - 76)));
      const STAGE_H = Math.max(1, Math.round(STAGE_W / config.aspect));
      const OUT_W = config.outWidth;
      const OUT_H = Math.max(1, Math.round(OUT_W / config.aspect));

      const objectUrl = URL.createObjectURL(file);
      const image = new Image();

      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        BB.toast('这张图片打不开，换一张试试', 'error');
        resolve(null);
      };

      image.onload = () => {
        const box = document.createElement('div');
        box.className = 'crop-mask';
        box.innerHTML = `
          <div class="crop-card${STAGE_W > 400 ? ' wide' : ''}" role="dialog" aria-label="${config.title}">
            <h3>${config.title}</h3>
            <p class="muted small">${config.hint}</p>
            <div class="crop-stage" style="width:${STAGE_W}px;height:${STAGE_H}px">
              <canvas width="${STAGE_W}" height="${STAGE_H}"></canvas>
            </div>
            <input type="range" min="100" max="320" value="100" class="crop-zoom" aria-label="缩放">
            <div class="crop-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-cancel>取消</button>
              <button type="button" class="btn btn-primary btn-sm" data-ok>确定</button>
            </div>
          </div>`;
        document.body.appendChild(box);

        const stage = box.querySelector('.crop-stage');
        const canvas = box.querySelector('canvas');
        const context = canvas.getContext('2d');
        const zoom = box.querySelector('.crop-zoom');

        const minScale = Math.max(STAGE_W / image.width, STAGE_H / image.height);
        let scale = minScale;
        let offsetX = (STAGE_W - image.width * scale) / 2;
        let offsetY = (STAGE_H - image.height * scale) / 2;

        const clamp = () => {
          const width = image.width * scale;
          const height = image.height * scale;
          offsetX = width <= STAGE_W ? (STAGE_W - width) / 2 : Math.min(0, Math.max(STAGE_W - width, offsetX));
          offsetY = height <= STAGE_H ? (STAGE_H - height) / 2 : Math.min(0, Math.max(STAGE_H - height, offsetY));
        };

        const paint = () => {
          context.clearRect(0, 0, STAGE_W, STAGE_H);
          context.drawImage(image, offsetX, offsetY, image.width * scale, image.height * scale);
          context.save();
          context.strokeStyle = 'rgba(255,255,255,.92)';
          context.lineWidth = 2;
          if (config.round) {
            context.beginPath();
            context.arc(STAGE_W / 2, STAGE_H / 2, Math.min(STAGE_W, STAGE_H) / 2 - 10, 0, Math.PI * 2);
            context.stroke();
          } else {
            context.strokeRect(1, 1, STAGE_W - 2, STAGE_H - 2);
          }
          context.restore();
        };

        const draw = () => {
          scale = minScale * (Number(zoom.value) / 100);
          clamp();
          paint();
        };

        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        stage.addEventListener('pointerdown', (event) => {
          dragging = true;
          lastX = event.clientX;
          lastY = event.clientY;
          stage.setPointerCapture(event.pointerId);
        });
        stage.addEventListener('pointermove', (event) => {
          if (!dragging) return;
          offsetX += event.clientX - lastX;
          offsetY += event.clientY - lastY;
          lastX = event.clientX;
          lastY = event.clientY;
          clamp();
          paint();
        });
        stage.addEventListener('pointerup', () => {
          dragging = false;
        });
        stage.addEventListener('pointercancel', () => {
          dragging = false;
        });
        stage.addEventListener(
          'wheel',
          (event) => {
            event.preventDefault();
            zoom.value = String(Math.min(320, Math.max(100, Number(zoom.value) - event.deltaY * 0.12)));
            draw();
          },
          { passive: false },
        );
        zoom.addEventListener('input', draw);

        const finish = (blob) => {
          URL.revokeObjectURL(objectUrl);
          box.remove();
          resolve(blob);
        };

        box.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
        box.querySelector('[data-ok]').addEventListener('click', () => {
          const output = document.createElement('canvas');
          output.width = OUT_W;
          output.height = OUT_H;
          output.getContext('2d').drawImage(canvas, 0, 0, STAGE_W, STAGE_H, 0, 0, OUT_W, OUT_H);
          output.toBlob((blob) => finish(blob), 'image/png');
        });

        draw();
      };

      image.src = objectUrl;
    });

  /** 头像：裁成方形，圆形参考线 */
  BB.cropSquare = (file, { size = 256 } = {}) =>
    BB.cropImage(file, {
      aspect: 1,
      stageWidth: 320,
      outWidth: size,
      round: true,
      title: '裁剪头像',
      hint: '拖动图片调整位置，滚轮或滑块缩放；圆形区域内的部分会作为头像。',
    });

  /** 个人主页封面：裁成 3:1 横图（默认 1440×480） */
  BB.cropCover = (file, { width = 1440 } = {}) =>
    BB.cropImage(file, {
      aspect: 3,
      stageWidth: 432,
      outWidth: width,
      title: '裁剪封面',
      hint: '拖动图片调整位置，滚轮或滑块缩放；框内的横条会显示在个人主页顶部（建议用 3:1 的横图）。',
    });

  window.BB = BB;
})();
