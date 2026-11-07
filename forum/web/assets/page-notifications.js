BB.boot(async () => {
  const list = document.getElementById('notifList');
  const hint = document.getElementById('notifHint');
  const readAllButton = document.getElementById('readAllBtn');

  if (!BB.state.me) {
    list.innerHTML = `<div class="empty">登录后才能看到自己的通知。<br><br>
      <a class="btn btn-primary btn-sm" href="${BB.loginLink('/notifications.html')}">去登录</a></div>`;
    readAllButton.style.display = 'none';
    return;
  }

  const page = Math.max(1, Number(BB.param('page') || 1) || 1);
  const data = await BB.api(`/api/notifications?page=${page}&per_page=20`);

  BB.state.unread = data.unread;
  BB.refreshNav();
  hint.textContent = `${data.pagination.total} 组通知，${data.unread} 条未读`;

  const actionText = (item) => {
    if (item.type === 'system') return '发来一条消息';
    if (item.type === 'mention') return '在帖子里提到了你';
    if (item.type === 'reply' && item.target_kind === 'post') return '回复了你的回复';
    return '回复了你的主题';
  };

  const actorsText = (item) => {
    if (!item.actors || item.actors.length === 0) return item.type === 'system' ? '管理团队' : '系统';
    const first = item.actors[0].display_name || item.actors[0].username;
    if (item.actor_count > 1) return `${first} 等 ${item.actor_count} 人`;
    return first;
  };

  list.innerHTML = data.items.length
    ? data.items
        .map((item) => {
          const target = item.thread_id
            ? `/thread.html?id=${item.thread_id}${item.post_id ? `#post-${item.post_id}` : ''}`
            : null;
          const avatars = (item.actors || [])
            .slice(0, 3)
            .map((actor) => BB.avatar(actor, 'avatar-sm'))
            .join('');
          return `<div class="notif-row${item.unread ? ' unread' : ''}" data-ids="${item.ids.join(',')}" ${
            target ? `data-href="${target}"` : ''
          }>
            <div class="notif-actors">${avatars || '<span class="avatar avatar-sm" style="background:#9bb39d">🔔</span>'}</div>
            <div class="notif-body">
              <div class="notif-title">
                <a href="${target || '/notifications.html'}">${BB.esc(actorsText(item))}</a>
                <span class="light">${actionText(item)}</span>
                ${item.count > 1 ? `<span class="chip chip-grey">共 ${item.count} 条</span>` : ''}
                ${item.thread_title ? `<span class="light">· 「${BB.esc(item.thread_title)}」</span>` : ''}
              </div>
              ${item.excerpt ? `<div class="notif-excerpt">${BB.esc(item.excerpt)}</div>` : ''}
            </div>
            ${item.unread ? '<span class="notif-dot"></span>' : ''}
            <span class="notif-time">${BB.time(item.created_at)}</span>
          </div>`;
        })
        .join('')
    : '<div class="empty">还没有通知。别人回复你的主题、回复你的楼层或在帖子里 @ 你，就会出现在这里。</div>';

  document.getElementById('pager').innerHTML = BB.pagination(
    data.pagination,
    (target) => `/notifications.html?page=${target}`,
  );

  document.querySelectorAll('.notif-row[data-href]').forEach((row) => {
    row.addEventListener('click', async (event) => {
      if (event.target.closest('a')) return;
      const ids = (row.dataset.ids || '')
        .split(',')
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
      try {
        await BB.api('/api/notifications/read', { method: 'POST', body: { ids } });
      } catch {
        /* 标记失败也不影响跳转 */
      }
      location.href = row.dataset.href;
    });
  });

  readAllButton.addEventListener('click', async () => {
    await BB.markAllRead();
    hint.textContent = `${data.pagination.total} 组通知，0 条未读`;
    document.querySelectorAll('.notif-row.unread').forEach((row) => {
      row.classList.remove('unread');
      const dot = row.querySelector('.notif-dot');
      if (dot) dot.remove();
    });
    BB.toast('已全部标为已读', 'ok');
  });
});
