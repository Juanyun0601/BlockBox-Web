BB.boot(async () => {
  const [boardData, threadData, tagData] = await Promise.all([
    BB.api('/api/boards'),
    BB.api('/api/threads?sort=latest&per_page=8'),
    BB.api('/api/tags'),
  ]);

  const { boards, stats } = boardData;

  document.getElementById('statsRow').innerHTML = `
    <div class="stat"><b>${BB.num(stats.users)}</b><span>注册成员</span></div>
    <div class="stat"><b>${BB.num(stats.threads)}</b><span>主题</span></div>
    <div class="stat"><b>${BB.num(stats.posts)}</b><span>回复</span></div>
    <div class="stat"><b>${BB.num(stats.online)}</b><span>15 分钟在线</span></div>`;

  document.getElementById('boardGrid').innerHTML = boards.length
    ? boards
        .map(
          (board) => `
      <a class="board-card" href="/board.html?slug=${encodeURIComponent(board.slug)}">
        <span class="board-icon">${BB.esc(board.icon || '💬')}</span>
        <div class="board-card-body">
          <h3>${BB.esc(board.name)} <span>${BB.num(board.thread_count)} 主题</span></h3>
          <p>${BB.esc(board.description || '')}</p>
        </div>
      </a>`,
        )
        .join('')
    : '<div class="empty">还没有板块</div>';

  const threads = threadData.threads || [];
  document.getElementById('latestThreads').innerHTML = threads.length
    ? threads.map((thread) => BB.threadRow(thread)).join('')
    : `<div class="empty">还没有人发帖，你可以是第一个。<br><br><a class="btn btn-primary btn-sm" href="/new.html">发第一帖</a></div>`;

  const newest = stats.newest_user
    ? `<a href="/user.html?id=${stats.newest_user.id}">${BB.esc(stats.newest_user.display_name)}</a>`
    : '暂无';

  document.getElementById('sideStats').innerHTML = `
    <li>最近 24 小时新增 ${BB.num(stats.new_users)} 位成员</li>
    <li>新加入：${newest}</li>
    <li>共 ${BB.num(stats.users)} 位成员、${BB.num(stats.threads)} 个主题</li>`;

  const tags = tagData.tags || [];
  document.getElementById('tagCloud').innerHTML = tags.length
    ? tags
        .map(
          (tag) =>
            `<a href="/search.html?q=${encodeURIComponent('#' + tag.tag)}">#${BB.esc(tag.tag)} <b>${BB.num(tag.n)}</b></a>`,
        )
        .join('')
    : '<span class="muted small">还没有标签，发帖时加上就能出现在这里</span>';
});
