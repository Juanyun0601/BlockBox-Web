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
    ]
      .filter(Boolean)
      .join('');

    return `<article class="card lobby-room">
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

  async function load(showSkeleton) {
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
      refreshBtn.disabled = false;
    }
  }

  grid.addEventListener('click', async (event) => {
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

  let searchTimer = null;
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
