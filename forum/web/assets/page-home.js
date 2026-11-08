BB.boot(async () => {
  const [boardData, threadData, tagData, lobbyData] = await Promise.all([
    BB.api('/api/boards'),
    BB.api('/api/threads?sort=latest&per_page=8'),
    BB.api('/api/tags'),
    BB.api('/api/lobby/rooms?per_page=6').catch(() => ({ rooms: [] })),
  ]);

  // 侧栏「每日签到」独立加载，论坛其它内容不受影响
  mountHomeCheckin();

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

// ------------------------------------------------------------ 每日签到

const CHECKIN_CUBE =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 2.6 21 7.4v9.2L12 21.4 3 16.6V7.4z"/><path d="m3 7.4 9 4.8 9-4.8"/><path d="M12 12.2v9.2"/></svg>';

async function mountHomeCheckin() {
  const host = document.getElementById('homeCheckin');
  if (!host) return;
  if (!BB.state.me) {
    renderHomeCheckin(null);
    return;
  }
  try {
    renderHomeCheckin(await BB.api('/api/points'));
  } catch {
    host.innerHTML = '<p class="muted small">签到信息加载失败，刷新页面试试。</p>';
  }
}

function renderHomeCheckin(state) {
  const host = document.getElementById('homeCheckin');
  if (!host) return;

  if (!state) {
    host.innerHTML = `
      <p class="checkin-login">登录后每天签到领方块，连续 7 天奖励越领越多。</p>
      <a class="btn btn-primary btn-sm" href="${BB.loginLink('/')}">登录签到</a>`;
    return;
  }

  const checked = !!state.checked_in_today;
  const reward = checked ? state.reward_next : state.reward_today;
  const streakText = state.streak > 0 ? `连续签到 ${state.streak} 天` : '今天签到开始记录';
  const rewardText = checked
    ? `今天已领 ${state.reward_today} 方块，明天可得 ${reward} 方块`
    : `今天签到可得 ${reward} 方块`;
  const days = (state.week || [])
    .map(
      (day) =>
        `<span class="checkin-day${day.checked ? ' checked' : ''}${day.current ? ' current' : ''}" title="第 ${day.day} 天 · ${day.reward} 方块">${day.day}</span>`,
    )
    .join('');
  const gift = state.sunday && state.sunday.gift_pending > 0
    ? '神秘礼包已到账，内容敬请期待'
    : state.sunday && state.sunday.is_sunday
      ? '今天是周日，签到送神秘礼包'
      : '每周天签到都有神秘礼包';
  const pendingGift = state.sunday && state.sunday.gift_pending > 0
    ? `<span>待开启 ${state.sunday.gift_pending} 份</span>`
    : '';

  host.innerHTML = `
    <div class="checkin-top">
      <span class="checkin-balance">${CHECKIN_CUBE}<b>${BB.num(state.points)}</b><i>方块</i></span>
      <span class="checkin-streak">${streakText}</span>
    </div>
    <div class="checkin-days" aria-label="7 天签到进度">${days}</div>
    <div class="checkin-reward">${rewardText}</div>
    <button class="btn btn-primary btn-sm checkin-btn" id="homeCheckinBtn"${checked ? ' disabled' : ''}>${checked ? '今天已签到' : `签到领 ${reward} 方块`}</button>
    <p class="checkin-gift">🎁 <span>${gift}</span>${pendingGift}</p>`;

  const button = host.querySelector('#homeCheckinBtn');
  if (button && !checked) button.addEventListener('click', () => homeCheckin(button));
}

async function homeCheckin(button) {
  button.disabled = true;
  button.textContent = '签到中…';
  try {
    const result = await BB.api('/api/points/check-in', { method: 'POST', body: {} });
    BB.setPoints(result.points);
    renderHomeCheckin(result);
    BB.toast(
      result.sunday_gift
        ? `+${result.awarded} 方块，神秘礼包已记下，敬请期待`
        : `+${result.awarded} 方块，连续签到第 ${result.streak_day} 天`,
      'ok',
    );
  } catch (error) {
    if (error.code === 'already_checked_in') mountHomeCheckin();
    else {
      button.disabled = false;
      button.textContent = '签到';
    }
    BB.toast(error.message || '签到失败，稍后再试', 'error');
  }
}
