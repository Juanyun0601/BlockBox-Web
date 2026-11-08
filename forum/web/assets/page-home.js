BB.boot(async () => {
  const [boardData, threadData, tagData, lobbyData] = await Promise.all([
    BB.api('/api/boards'),
    BB.api('/api/threads?sort=latest&per_page=8'),
    BB.api('/api/tags'),
    BB.api('/api/lobby/rooms?per_page=6').catch(() => ({ rooms: [] })),
  ]);

  const { boards, stats } = boardData;

  document.getElementById('statsRow').innerHTML = `
    <div class="stat"><b>${BB.num(stats.users)}</b><span>注册成员</span></div>
    <div class="stat"><b>${BB.num(stats.threads)}</b><span>主题数</span></div>
    <div class="stat"><b>${BB.num(stats.posts)}</b><span>回复数</span></div>
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

  const lobbyRooms = (lobbyData.rooms || []).slice(0, 6);
  const lobbyTotal = Number(lobbyData.total) || lobbyRooms.length;
  document.getElementById('homeLobby').innerHTML = lobbyRooms.length
    ? `${lobbyRooms
        .map((room) => {
          const code = room.invite_code || room.address || '';
          const codeLabel = room.invite_code ? '邀请码' : '连接地址';
          const host = (room.host && (room.host.display_name || room.host.username)) || '';
          const meta = [room.game_version, room.loader, host].filter(Boolean).map(BB.esc).join(' · ');
          return `<a class="lobby-mini" href="/lobby.html">
            <span class="lobby-mini-core">${BB.esc(room.core_label || '联机')}</span>
            <span class="lobby-mini-body">
              <b>${BB.esc(room.title)}</b>
              <span class="muted small">${meta || '等待玩家加入'}</span>
            </span>
            <span class="lobby-mini-code"><i>${codeLabel}</i>${BB.esc(code)}</span>
          </a>`;
        })
        .join('')}<a class="lobby-mini-more" href="/lobby.html">查看全部 ${BB.num(lobbyTotal)} 个在线房间 →</a>`
    : `<div class="empty">现在还没有人开房间。<br><br>在方块盒子的联机页点「发布到联机大厅」，房间就会出现在这里。<br><br><a class="btn btn-ghost btn-sm" href="/lobby.html">去联机大厅看看</a></div>`;
});
