BB.boot(async () => {
  const slug = BB.param('slug');
  if (!slug) {
    location.replace('/');
    return;
  }
  const sort = ['latest', 'new', 'hot'].includes(BB.param('sort') || '') ? BB.param('sort') : 'latest';
  const page = Math.max(1, Number(BB.param('page') || 1) || 1);
  const tag = (BB.param('tag') || '').trim();

  const query = new URLSearchParams({ sort, page: String(page), per_page: '25' });
  if (tag) query.set('tag', tag);
  const data = await BB.api(`/api/boards/${encodeURIComponent(slug)}?${query.toString()}`);

  const board = data.board;
  document.title = `${board.name}${tag ? ` · #${tag}` : ''} · 方块盒子论坛`;
  document.getElementById('crumbBoard').textContent = board.name;

  screenBoardHead(board);
  renderTabs();
  renderThreads();
  renderPager();

  function screenBoardHead(currentBoard) {
    const head = document.getElementById('boardHead');
    const tagBanner = tag
      ? `<div class="post-tags" style="margin-top: 8px">
           <span class="tag">#${BB.esc(tag)}</span>
           <a class="small muted" href="/board.html?slug=${encodeURIComponent(slug)}&sort=${sort}">清除筛选</a>
         </div>`
      : '';
    head.innerHTML = `
      <span class="board-icon">${BB.esc(currentBoard.icon || '💬')}</span>
      <div>
        <h1>${BB.esc(currentBoard.name)}</h1>
        <p>${BB.esc(currentBoard.description || '')}</p>
        ${tagBanner}
      </div>
      <div class="actions">
        <a class="btn btn-primary btn-sm" href="/new.html?board=${encodeURIComponent(currentBoard.slug)}">在这里发帖</a>
      </div>`;
  }

  function renderTabs() {
    const tabs = [
      ['latest', '最新回复'],
      ['new', '最新发布'],
      ['hot', '最热'],
    ];
    document.getElementById('sortTabs').innerHTML = tabs
      .map(([key, label]) => {
        const href = `/board.html?slug=${encodeURIComponent(slug)}&sort=${key}${
          tag ? `&tag=${encodeURIComponent(tag)}` : ''
        }`;
        return `<a href="${href}" class="${key === sort ? 'active' : ''}">${label}</a>`;
      })
      .join('');
  }

  function renderThreads() {
    document.getElementById('boardStat').textContent =
      `${BB.num(board.thread_count)} 个主题 · ${BB.num(board.post_count)} 条回复`;

    const threads = data.threads || [];
    document.getElementById('threadList').innerHTML = threads.length
      ? threads.map((thread) => BB.threadRow(thread, { showBoard: false })).join('')
      : `<div class="empty">${tag ? `没有带「#${BB.esc(tag)}」标签的主题` : '这个板块还没有主题，来发第一帖？'}</div>`;
  }

  function renderPager() {
    document.getElementById('pager').innerHTML = BB.pagination(
      data.pagination,
      (target) =>
        `/board.html?slug=${encodeURIComponent(slug)}&sort=${sort}&page=${target}${
          tag ? `&tag=${encodeURIComponent(tag)}` : ''
        }`,
    );
  }
});
