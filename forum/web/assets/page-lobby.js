/* 联机大厅：网页端只展示房间信息与邀请码，加入游戏要回到方块盒子客户端 */
BB.boot(async () => {
  const params = new URLSearchParams(location.search);
  let keyword = (params.get('q') || '').trim();
  let core = (params.get('core') || '').trim();
  let page = Math.max(1, Math.floor(Number(params.get('page') || 1)) || 1);

  const CORES = [
    ['', '全部'],
    ['terracotta', '陶瓦联机'],
    ['hongshi', '红石联机'],
    ['frp', '内网穿透'],
    ['custom', '直连'],
  ];
  const STATUS_TEXT = { waiting: '等待中', playing: '游戏中', full: '已满' };

  const grid = document.getElementById('lobbyGrid');
  const stat = document.getElementById('lobbyStat');
  const search = document.getElementById('lobbySearch');
  const refreshBtn = document.getElementById('lobbyRefresh');
  const coreTabs = document.getElementById('coreTabs');

  search.value = keyword;

  /** 生成带筛选条件的页面地址（分页链接用） */
  function pageUrl(nextPage) {
    const query = new URLSearchParams();
    if (keyword) query.set('q', keyword);
    if (core) query.set('core', core);
    if (nextPage > 1) query.set('page', String(nextPage));
    const text = query.toString();
    return text ? `?${text}` : '/lobby.html';
  }

  function syncUrl() {
    try {
      history.replaceState(null, '', pageUrl(page));
    } catch {
      /* 个别环境不允许改地址，忽略 */
    }
  }

  function renderTabs() {
    coreTabs.innerHTML = CORES.map(
      ([key, label]) =>
        `<button type="button" data-core="${BB.esc(key)}"${key === core ? ' class="active"' : ''}>${BB.esc(label)}</button>`,
    ).join('');

    coreTabs.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        core = button.dataset.core || '';
        page = 1;
        renderTabs();
        syncUrl();
        load(false);
      });
    });
  }

  function codeOf(room) {
    return room.invite_code || room.address || '';
  }

  /** 房间详细介绍（Markdown）模态：点卡片的「详细介绍」按钮弹出，点遮罩或关闭按钮退场 */
  function showMdModal(content) {
    const overlay = document.createElement('div');
    overlay.className = 'lobby-md-overlay';
    overlay.innerHTML = `
      <div class="lobby-md-modal card" role="dialog" aria-modal="true">
        <div class="lobby-md-head">
          <h3>详细介绍</h3>
          <button type="button" class="btn btn-ghost btn-sm" data-close>关闭</button>
        </div>
        <div class="lobby-md-body post-content">${BB.md(content)}</div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', function esc(event) {
      if (event.key !== 'Escape') return;
      document.removeEventListener('keydown', esc);
      close();
    });
  }

  function cardOf(room) {
    const joinText = codeOf(room);
    const isAddress = !room.invite_code && !!room.address;
    const mods = Array.isArray(room.mods) ? room.mods : [];
    const modNames = mods.slice(0, 3).join('、') + (mods.length > 3 ? ` 等 ${mods.length} 个` : '');
    const statusText = STATUS_TEXT[room.status] || '联机中';
    const hostName = (room.host && (room.host.display_name || room.host.username)) || '未知房主';

    const tags = [
      room.core_label ? `<span class="lobby-tag">${BB.esc(room.core_label)}</span>` : '',
      room.game_version ? `<span class="lobby-tag">${BB.esc(room.game_version)}</span>` : '',
      room.loader ? `<span class="lobby-tag">${BB.esc(room.loader)}</span>` : '',
      mods.length ? `<span class="lobby-tag">${mods.length} 个模组</span>` : '',
      room.modpack_mode && room.modpack_name
        ? `<span class="lobby-tag lobby-tag-pack">📦 ${BB.esc(room.modpack_name)}</span>`
        : '',
    ]
      .filter(Boolean)
      .join('');

    const cover = room.cover && room.cover.startsWith('/uploads/')
      ? `<a class="lobby-room-cover" href="${BB.esc(room.cover)}" target="_blank">
           <img src="${BB.esc(room.cover)}" alt="${BB.esc(room.title)}" loading="lazy">
         </a>`
      : '';

    // Markdown 介绍：有正文时给一枚「介绍」按钮，点开模态看渲染后的全文
    const mdBtn = room.md && room.md.trim()
      ? `<button type="button" class="btn btn-ghost btn-sm lobby-md-btn" data-md="${encodeURIComponent(room.md)}">📝 详细介绍</button>`
      : '';

    return `<article class="card lobby-room">
      ${cover}
      <div class="lobby-room-head">
        <div class="lobby-room-title">
          <h3>${BB.esc(room.title)}</h3>
          <span class="chip chip-grey">${BB.esc(statusText)}</span>
        </div>
        <a class="lobby-room-host" href="/user.html?id=${Number(room.host && room.host.id) || 0}">
          ${BB.avatar(room.host, 'avatar-sm')}<span>${BB.esc(hostName)}</span>
        </a>
      </div>

      <div class="lobby-room-tags">${tags}</div>

      ${room.description ? `<p class="lobby-room-desc">${BB.esc(room.description)}</p>` : ''}
      ${modNames ? `<p class="lobby-room-mods">模组：${BB.esc(modNames)}</p>` : ''}
      ${mdBtn}

      <div class="lobby-room-join">
        <span class="lobby-join-label">${isAddress ? '连接地址' : '邀请码'}</span>
        <code class="lobby-code">${BB.esc(joinText)}</code>
        <button type="button" class="btn btn-ghost btn-sm" data-copy="${BB.esc(joinText)}">复制</button>
      </div>
      <p class="lobby-room-note">网页端只能查看邀请码 / 连接地址；在方块盒子客户端「实例助手 → 联机 → 联机大厅」里可以一键加入。</p>

      <div class="lobby-room-foot">
        <span>已有 ${Number(room.join_count) || 0} 人加入</span>
        <span class="dot">·</span>
        <span>上限 ${Number(room.max_players) || 8} 人</span>
        <span class="dot">·</span>
        <span>${BB.time(room.updated_at || room.created_at)}更新</span>
      </div>
    </article>`;
  }

  let searchTimer = null;
  let loading = false;

  async function load(showSkeleton) {
    if (loading) return;
    loading = true;
    if (showSkeleton) grid.innerHTML = '<div class="skeleton">正在加载房间…</div>';
    refreshBtn.disabled = true;
    try {
      const query = new URLSearchParams();
      if (keyword) query.set('q', keyword);
      if (core) query.set('core', core);
      query.set('page', String(page));
      query.set('per_page', '30');

      const data = await BB.api(`/api/lobby/rooms?${query.toString()}`);
      const rooms = data.rooms || [];
      stat.textContent = `在线房间 ${rooms.length} 个`;
      grid.innerHTML = rooms.length
        ? rooms.map(cardOf).join('')
        : `<div class="empty">现在还没有人开房间。<br><br>在方块盒子的联机页点「发布到联机大厅」，房间就会出现在这里。</div>`;
      document.getElementById('lobbyPager').innerHTML = BB.pagination(data.pagination, pageUrl);
    } catch (error) {
      grid.innerHTML = `<div class="empty">加载失败：${BB.esc(error.message || '请稍后重试')}</div>`;
    } finally {
      loading = false;
      refreshBtn.disabled = false;
    }
  }

  grid.addEventListener('click', async (event) => {
    // Markdown 介绍模态
    const mdButton = event.target.closest('.lobby-md-btn');
    if (mdButton) {
      showMdModal(decodeURIComponent(mdButton.dataset.md || ''));
      return;
    }
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const text = button.dataset.copy || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      BB.toast('邀请码已复制', 'ok');
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      try {
        document.execCommand('copy');
        BB.toast('邀请码已复制', 'ok');
      } catch {
        BB.toast('复制失败，请手动选中复制', 'error');
      }
      helper.remove();
    }
  });

  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      keyword = search.value.trim();
      page = 1;
      syncUrl();
      load(false);
    }, 350);
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    keyword = search.value.trim();
    page = 1;
    syncUrl();
    load(false);
  });

  refreshBtn.addEventListener('click', () => load(false));

  renderTabs();
  await load(true);

  // 大厅靠 20 秒轮询保持新鲜，切到后台就停，回来再补一次
  setInterval(() => {
    if (document.hidden) return;
    load(false);
  }, 20000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load(false);
  });
});
