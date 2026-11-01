BB.boot(async () => {
  const host = document.getElementById('adminHost');

  if (!BB.state.me) {
    host.innerHTML = `<div class="card composer">
      <h3>需要管理员权限</h3>
      <p class="muted small" style="margin-bottom: 14px">请先用管理员账号登录。</p>
      <div class="composer-foot"><a class="btn btn-primary" href="${BB.loginLink('/admin.html')}">去登录</a></div>
    </div>`;
    return;
  }
  if (BB.state.me.role !== 'admin') {
    host.innerHTML = `<div class="card composer">
      <h3>没有权限</h3>
      <p class="muted small">当前账号不是管理员，如需管理权限请联系站点负责人。</p>
    </div>`;
    return;
  }

  let overview = null;
  let reports = null;
  let tagData = null;
  let userQuery = '';
  let adminUsers = [];
  let feedbackData = null;
  let feedbackStatus = 'open';

  async function loadOverview() {
    const [data, reportData, tagResult, feedbackResult] = await Promise.all([
      BB.api('/api/admin/overview'),
      BB.api('/api/admin/reports?status=open'),
      BB.api('/api/admin/tags'),
      BB.api(`/api/admin/feedbacks?status=${feedbackStatus}&per_page=50`),
    ]);
    overview = data;
    reports = reportData;
    tagData = tagResult;
    feedbackData = feedbackResult;
    render();
  }

  function statCard(value, label) {
    return `<div class="stat"><b>${BB.num(value)}</b><span>${label}</span></div>`;
  }

  function render() {
    const stats = overview.stats;
    document.getElementById('adminHint').textContent = `数据库里共 ${overview.stats.users} 位成员`;

    host.innerHTML = `
      <div class="admin-grid">
        ${statCard(stats.users, '成员')}
        ${statCard(stats.threads, '主题')}
        ${statCard(stats.posts, '回复')}
        ${statCard(stats.online, '15 分钟在线')}
      </div>

      <section class="card admin-section">
        <h2>板块管理</h2>
        <table class="table">
          <thead><tr><th>板块</th><th>标识</th><th>名称</th><th>排序</th><th>主题 / 回复</th><th>操作</th></tr></thead>
          <tbody id="boardRows"></tbody>
        </table>
        <div class="admin-form" style="margin-top: 14px">
          <input class="input" id="newBoardSlug" placeholder="标识（英文小写）">
          <input class="input" id="newBoardName" placeholder="名称">
          <input class="input" id="newBoardDesc" placeholder="一句话简介">
          <input class="input" id="newBoardIcon" placeholder="图标" value="💬">
          <button class="btn btn-primary btn-sm" id="addBoardBtn">新增板块</button>
        </div>
        <div id="boardError"></div>
      </section>

      <section class="card admin-section">
        <h2>标签管理</h2>
        <table class="table">
          <thead><tr><th>标签</th><th>使用次数</th><th>推荐</th><th>操作</th></tr></thead>
          <tbody id="tagRows"></tbody>
        </table>
        <div class="admin-form" style="margin-top: 14px; grid-template-columns: 2fr 1fr auto">
          <input class="input" id="mergeFrom" placeholder="要合并的旧标签，逗号分隔，如：优化,优化设置">
          <input class="input" id="mergeTo" placeholder="合并成（留空=沿用第一个）">
          <button class="btn btn-primary btn-sm" id="mergeBtn">合并标签</button>
        </div>
        <div id="tagError"></div>
      </section>

      <section class="card admin-section">
        <h2>审核队列 ${reports.counts.open > 0 ? `<span class="chip chip-danger">待处理 ${reports.counts.open}</span>` : '<span class="chip chip-grey">没有待处理的举报</span>'}</h2>
        <table class="table">
          <thead><tr><th>楼层</th><th>所属主题</th><th>作者</th><th>举报人</th><th>理由</th><th>时间</th><th>操作</th></tr></thead>
          <tbody id="reportRows"></tbody>
        </table>
        <div id="reportError"></div>
      </section>

      <section class="card admin-section">
        <h2>反馈管理 <span id="feedbackPendingChip"></span></h2>
        <div id="feedbackFilters" style="display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap"></div>
        <div id="feedbackRows"></div>
      </section>

      <section class="card admin-section">
        <h2>最近主题</h2>
        <table class="table">
          <thead><tr><th>标题</th><th>板块</th><th>作者</th><th>时间</th><th>操作</th></tr></thead>
          <tbody id="threadRows"></tbody>
        </table>
      </section>

      <section class="card admin-section">
        <h2>用户管理</h2>
        <div style="display: flex; gap: 8px; margin-bottom: 12px">
          <input class="input" id="userSearch" placeholder="搜用户名或昵称" style="max-width: 260px" value="${BB.esc(userQuery)}">
          <button class="btn btn-ghost btn-sm" id="userSearchBtn">搜索</button>
        </div>
        <table class="table">
          <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>主题 / 回复</th><th>注册时间</th><th>操作</th></tr></thead>
          <tbody id="userRows"></tbody>
        </table>
      </section>`;

    renderBoards();
    renderThreads();
    renderUsers();
    renderReports();
    renderFeedback();
    renderTags();

    document.getElementById('addBoardBtn').addEventListener('click', addBoard);
    document.getElementById('mergeBtn').addEventListener('click', mergeTags);
    document.getElementById('userSearchBtn').addEventListener('click', () => {
      userQuery = document.getElementById('userSearch').value.trim();
      renderUsers();
    });
    document.getElementById('userSearch').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        userQuery = event.target.value.trim();
        renderUsers();
      }
    });
  }

  function renderBoards() {
    const body = document.getElementById('boardRows');
    body.innerHTML = overview.boards
      .map(
        (board) => `
      <tr data-board="${board.id}">
        <td>${BB.esc(board.icon || '💬')}</td>
        <td class="mono small">${BB.esc(board.slug)}</td>
        <td><input class="input" data-field="name" value="${BB.esc(board.name)}" style="height: 32px; padding: 0 8px"></td>
        <td><input class="input" data-field="sort_order" type="number" value="${board.sort_order}" style="height: 32px; padding: 0 8px; width: 80px"></td>
        <td class="small">${BB.num(board.thread_count)} / ${BB.num(board.post_count)}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-act="save">保存</button>
          <button class="btn btn-danger btn-sm" data-act="delete">删除</button>
        </td>
      </tr>`,
      )
      .join('');

    body.querySelectorAll('tr').forEach((row) => {
      const boardId = Number(row.dataset.board);
      row.querySelector('[data-act="save"]').addEventListener('click', async () => {
        try {
          await BB.api(`/api/admin/boards/${boardId}`, {
            method: 'PATCH',
            body: {
              name: row.querySelector('[data-field="name"]').value,
              sort_order: Number(row.querySelector('[data-field="sort_order"]').value),
            },
          });
          BB.toast('板块已更新', 'ok');
          loadOverview();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
      row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        if (!confirm('确定删除这个板块？板块里有主题时不能删。')) return;
        try {
          await BB.api(`/api/admin/boards/${boardId}`, { method: 'DELETE' });
          BB.toast('板块已删除', 'ok');
          loadOverview();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    });
  }

  async function addBoard() {
    const errorHost = document.getElementById('boardError');
    try {
      await BB.api('/api/admin/boards', {
        method: 'POST',
        body: {
          slug: document.getElementById('newBoardSlug').value.trim(),
          name: document.getElementById('newBoardName').value.trim(),
          description: document.getElementById('newBoardDesc').value.trim(),
          icon: document.getElementById('newBoardIcon').value.trim() || '💬',
          sort_order: 100,
        },
      });
      BB.showError(errorHost, '');
      BB.toast('板块已新增', 'ok');
      loadOverview();
    } catch (error) {
      BB.showError(errorHost, error.message);
    }
  }

  function renderThreads() {
    const body = document.getElementById('threadRows');
    body.innerHTML = overview.recent_threads
      .map(
        (thread) => `
      <tr>
        <td><a href="/thread.html?id=${thread.id}">${BB.esc(thread.title)}</a></td>
        <td class="small">${BB.esc(thread.board_name)}</td>
        <td class="small">${BB.esc(thread.display_name || thread.username)}</td>
        <td class="small nowrap">${BB.time(thread.created_at)}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-thread="${thread.id}" data-act="pin">置顶/取消</button>
          <button class="btn btn-ghost btn-sm" data-thread="${thread.id}" data-act="lock">锁定/取消</button>
          <button class="btn btn-danger btn-sm" data-thread="${thread.id}" data-act="delete">删除</button>
        </td>
      </tr>`,
      )
      .join('');

    body.querySelectorAll('[data-thread]').forEach((button) => {
      button.addEventListener('click', async () => {
        const threadId = Number(button.dataset.thread);
        const action = button.dataset.act;
        try {
          if (action === 'pin') await BB.api(`/api/admin/threads/${threadId}`, { method: 'PATCH', body: { pinned: true } });
          if (action === 'lock') await BB.api(`/api/admin/threads/${threadId}`, { method: 'PATCH', body: { locked: true } });
          if (action === 'delete') {
            if (!confirm('确定删除这个主题？')) return;
            await BB.api(`/api/threads/${threadId}`, { method: 'DELETE' });
          }
          BB.toast('操作成功', 'ok');
          loadOverview();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    });
  }

  function renderTags() {
    const body = document.getElementById('tagRows');
    if (!tagData || tagData.tags.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="muted">还没有标签。发帖时加标签后会出现在这里。</td></tr>';
      return;
    }

    body.innerHTML = tagData.tags
      .slice(0, 80)
      .map(
        (item) => `
      <tr>
        <td><span class="tag">#${BB.esc(item.tag)}</span></td>
        <td class="small">${item.count}</td>
        <td>${item.featured ? '<span class="chip">推荐中</span>' : '<span class="muted small">—</span>'}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-tag="${BB.esc(item.tag)}" data-act="feature">${
            item.featured ? '取消推荐' : '设为推荐'
          }</button>
          <button class="btn btn-danger btn-sm" data-tag="${BB.esc(item.tag)}" data-act="delete">删除</button>
        </td>
      </tr>`,
      )
      .join('');

    body.querySelectorAll('[data-tag]').forEach((button) => {
      button.addEventListener('click', async () => {
        const tag = button.dataset.tag;
        const item = tagData.tags.find((entry) => entry.tag === tag);
        try {
          if (button.dataset.act === 'feature') {
            await BB.api('/api/admin/tags/feature', {
              method: 'POST',
              body: { tag, featured: !(item && item.featured) },
            });
            BB.toast('已更新推荐状态', 'ok');
          } else {
            if (!confirm(`删除标签「#${tag}」？帖子上的这个标签会被移除。`)) return;
            await BB.api('/api/admin/tags/delete', { method: 'POST', body: { tag } });
            BB.toast('标签已删除', 'ok');
          }
          loadOverview();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    });
  }

  async function mergeTags() {
    const errorHost = document.getElementById('tagError');
    const raw = document.getElementById('mergeFrom').value.trim();
    if (!raw) {
      BB.showError(errorHost, '先填要合并的旧标签');
      return;
    }
    const from = raw
      .split(/[,，、\s]+/)
      .map((item) => item.replace(/^#+/, '').trim())
      .filter(Boolean);
    const to = document.getElementById('mergeTo').value.trim().replace(/^#+/, '') || from[0];

    try {
      const result = await BB.api('/api/admin/tags/merge', { method: 'POST', body: { from, to } });
      BB.showError(errorHost, '');
      BB.toast(`已合并 ${result.merged.length} 个标签，影响 ${result.threads} 个主题`, 'ok');
      document.getElementById('mergeFrom').value = '';
      document.getElementById('mergeTo').value = '';
      loadOverview();
    } catch (error) {
      BB.showError(errorHost, error.message);
    }
  }

  function renderReports() {    const body = document.getElementById('reportRows');
    if (!reports || reports.reports.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="muted">暂时没有新的举报。</td></tr>';
      return;
    }

    body.innerHTML = reports.reports
      .map(
        (report) => `
      <tr>
        <td class="small">
          #${report.floor}
          <div class="muted" style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
            ${report.post_deleted ? '（内容已删除）' : BB.esc(report.excerpt || '')}
          </div>
        </td>
        <td class="small">${
          report.thread_deleted
            ? '（主题已删除）'
            : `<a href="/thread.html?id=${report.thread_id}">${BB.esc(report.thread_title || '')}</a>`
        }</td>
        <td class="small">${report.author ? BB.esc(report.author.display_name || report.author.username) : '—'}</td>
        <td class="small">${report.reporter ? BB.esc(report.reporter.username) : '—'}</td>
        <td class="small">${BB.esc(report.reason || '未填写')}</td>
        <td class="small nowrap">${BB.time(report.created_at)}</td>
        <td class="row-actions">
          <a class="btn btn-ghost btn-sm" href="/thread.html?id=${report.thread_id}#post-${report.post_id}">查看</a>
          <button class="btn btn-danger btn-sm" data-report="${report.id}" data-act="delete">删帖并处理</button>
          <button class="btn btn-ghost btn-sm" data-report="${report.id}" data-act="ignore">忽略</button>
        </td>
      </tr>`,
      )
      .join('');

    body.querySelectorAll('[data-report]').forEach((button) => {
      button.addEventListener('click', async () => {
        const reportId = Number(button.dataset.report);
        const action = button.dataset.act;
        if (action === 'delete' && !confirm('删除这条回复，并把举报标记为已处理？')) return;
        try {
          await BB.api(`/api/admin/reports/${reportId}`, {
            method: 'PATCH',
            body: action === 'delete' ? { status: 'resolved', delete_post: true } : { status: 'ignored' },
          });
          BB.toast('已处理', 'ok');
          loadOverview();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    });
  }

  function feedbackChip(status) {
    if (status === 'resolved') return '<span class="chip">已处理</span>';
    if (status === 'ignored') return '<span class="chip chip-grey">已忽略</span>';
    return '<span class="chip chip-warn">待处理</span>';
  }

  function feedbackTypeChip(type) {
    return type === 'feature'
      ? '<span class="chip chip-grey">功能建议</span>'
      : '<span class="chip chip-danger">问题反馈</span>';
  }

  // 反馈正文里的 GitHub 模板标题（### xxx）渲染成加粗
  function feedbackContentHtml(content) {
    return BB.esc(content).replace(/^### (.+)$/gm, '<b>$1</b>');
  }

  function feedbackSource(item) {
    return item.source === 'launcher'
      ? `启动器${item.app_version ? ` · v${BB.esc(item.app_version)}` : ''}`
      : '网页';
  }

  function renderFeedback() {
    if (!feedbackData) return;
    const counts = feedbackData.counts || {};

    const pendingChip = document.getElementById('feedbackPendingChip');
    pendingChip.innerHTML =
      counts.open > 0
        ? `<span class="chip chip-danger">待处理 ${counts.open}</span>`
        : '<span class="chip chip-grey">没有待处理的反馈</span>';

    const filters = document.getElementById('feedbackFilters');
    filters.innerHTML = [
      ['open', `待处理 ${counts.open || 0}`],
      ['resolved', `已处理 ${counts.resolved || 0}`],
      ['ignored', `已忽略 ${counts.ignored || 0}`],
      ['all', '全部'],
    ]
      .map(
        ([value, label]) =>
          `<button class="btn btn-sm ${feedbackStatus === value ? 'btn-primary' : 'btn-ghost'}" data-fstatus="${value}">${label}</button>`,
      )
      .join('');
    filters.querySelectorAll('[data-fstatus]').forEach((button) => {
      button.addEventListener('click', async () => {
        feedbackStatus = button.dataset.fstatus;
        try {
          feedbackData = await BB.api(`/api/admin/feedbacks?status=${feedbackStatus}&per_page=50`);
          renderFeedback();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    });

    const rows = document.getElementById('feedbackRows');
    if (!feedbackData.feedbacks || feedbackData.feedbacks.length === 0) {
      rows.innerHTML = '<div class="empty">暂时没有反馈。</div>';
      return;
    }

    rows.innerHTML = feedbackData.feedbacks
      .map(
        (item) => `
      <div class="feedback-admin-row">
        <div class="feedback-admin-main">
          <div>
            ${feedbackTypeChip(item.type)}
            ${feedbackChip(item.status)}
            <span class="chip chip-grey">${BB.esc(feedbackSource(item))}</span>
          </div>
          <div class="feedback-admin-content">${feedbackContentHtml(item.content)}</div>
          <div class="feedback-admin-meta">
            ${item.user ? `${BB.esc(item.user.display_name || item.user.username)}` : '已注销用户'}
            · ${BB.datetime(item.created_at)}
            ${item.handled_by ? ` · 由 ${BB.esc(item.handled_by)} 处理` : ''}
          </div>
          ${item.reply ? `<div class="feedback-reply"><b>已回复</b>：${BB.esc(item.reply)}</div>` : ''}
        </div>
        <div class="feedback-admin-actions">
          <input class="input" placeholder="回复（可选）" data-reply="${item.id}">
          <div class="btn-row">
            ${
              item.status === 'open'
                ? `<button class="btn btn-primary btn-sm" data-feedback="${item.id}" data-act="resolve">标记已处理</button>
                   <button class="btn btn-ghost btn-sm" data-feedback="${item.id}" data-act="ignore">忽略</button>`
                : `<button class="btn btn-ghost btn-sm" data-feedback="${item.id}" data-act="reopen">重新打开</button>`
            }
          </div>
        </div>
      </div>`,
      )
      .join('');

    rows.querySelectorAll('[data-feedback]').forEach((button) => {
      button.addEventListener('click', async () => {
        const feedbackId = Number(button.dataset.feedback);
        const action = button.dataset.act;
        const replyInput = rows.querySelector(`[data-reply="${feedbackId}"]`);
        const payload =
          action === 'resolve'
            ? { status: 'resolved', reply: replyInput ? replyInput.value.trim() : '' }
            : action === 'ignore'
              ? { status: 'ignored', reply: replyInput ? replyInput.value.trim() : '' }
              : { status: 'open', reply: '' };
        try {
          await BB.api(`/api/admin/feedbacks/${feedbackId}`, { method: 'PATCH', body: payload });
          BB.toast(action === 'reopen' ? '已重新打开' : '已处理', 'ok');
          feedbackData = await BB.api(`/api/admin/feedbacks?status=${feedbackStatus}&per_page=50`);
          renderFeedback();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    });
  }

  async function renderUsers() {
    const body = document.getElementById('userRows');
    const data = await BB.api(`/api/admin/users?q=${encodeURIComponent(userQuery)}&per_page=50`);
    adminUsers = data.users;
    body.innerHTML = data.users
      .map((user) => {
        const statusLabel =
          user.status === 'banned'
            ? '<span class="chip chip-danger">封禁</span>'
            : user.status === 'muted'
              ? '<span class="chip chip-warn">禁言</span>'
              : '<span class="chip chip-grey">正常</span>';
        return `
        <tr>
          <td>
            <a href="/user.html?id=${user.id}" style="display: flex; align-items: center; gap: 8px">
              ${BB.avatar(user, 'avatar-sm')}
              <span>${BB.esc(user.display_name || user.username)}<br><span class="small muted">@${BB.esc(user.username)}</span></span>
            </a>
          </td>
          <td>${user.role === 'admin' ? '<span class="chip">管理员</span>' : '<span class="chip chip-grey">成员</span>'}</td>
          <td>${statusLabel}</td>
          <td class="small">${BB.num(user.thread_count)} / ${BB.num(user.post_count)}</td>
          <td class="small">${BB.datetime(user.created_at).slice(0, 10)}</td>
          <td class="row-actions">
            <button class="btn btn-ghost btn-sm" data-user="${user.id}" data-act="role">${user.role === 'admin' ? '降为成员' : '设为管理员'}</button>
            <button class="btn btn-ghost btn-sm" data-user="${user.id}" data-act="mute">禁言 24 小时</button>
            <button class="btn btn-ghost btn-sm" data-user="${user.id}" data-act="restore">恢复正常</button>
            <button class="btn btn-danger btn-sm" data-user="${user.id}" data-act="ban">封禁</button>
          </td>
        </tr>`;
      })
      .join('');

    body.querySelectorAll('[data-user]').forEach((button) => {
      button.addEventListener('click', async () => {
        const userId = Number(button.dataset.user);
        const action = button.dataset.act;
        const payload =
          action === 'role'
            ? { role: adminUsers.find((u) => u.id === userId)?.role === 'admin' ? 'user' : 'admin' }
            : action === 'mute'
              ? { status: 'muted', mute_hours: 24 }
              : action === 'ban'
                ? { status: 'banned' }
                : { status: 'active' };
        try {
          await BB.api(`/api/admin/users/${userId}`, { method: 'PATCH', body: payload });
          BB.toast('已更新用户状态', 'ok');
          renderUsers();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    });
  }

  await loadOverview();
});
