BB.boot(async () => {
  const me = BB.state.me;
  const userId = Number(BB.param('id')) || (me ? me.id : 0);
  if (!userId) {
    location.replace(BB.loginLink('/user.html'));
    return;
  }

  const isSelf = !!me && me.id === userId;
  const rawTab = BB.param('tab');
  const tab = ['threads', 'replies', 'bookmarks', 'likes'].includes(rawTab) ? rawTab : 'threads';
  const page = Math.max(1, Number(BB.param('page') || 1) || 1);
  const data = await BB.api(`/api/users/${userId}`);
  const user = data.user;
  document.title = `${user.display_name || user.username} · 方块盒子论坛`;

  const roleChip = user.role === 'admin' ? '<span class="chip">管理员</span>' : '<span class="chip chip-grey">成员</span>';
  const statusChip =
    user.status === 'banned'
      ? '<span class="chip chip-danger">已封禁</span>'
      : user.status === 'muted'
        ? '<span class="chip chip-warn">已禁言</span>'
        : '';

  const coverHtml = user.cover
    ? `<img src="${BB.esc(user.cover)}" alt="" loading="lazy">`
    : isSelf
      ? '<span class="profile-cover-hint">还没有设置封面图</span>'
      : '';
  const coverAction = isSelf
    ? `<label class="profile-cover-action" title="上传或更换封面">📷 换封面
         <input type="file" id="coverInput" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
       </label>`
    : '';

  document.getElementById('profileCard').innerHTML = `
    <div class="profile-cover">${coverHtml}${coverAction}</div>
    <div class="profile-body">
      ${BB.avatar(user, 'avatar-lg')}
      <div class="info">
        <h1>${BB.esc(user.display_name || user.username)} ${roleChip}${statusChip}</h1>
        <div class="uname">@${BB.esc(user.username)}</div>
        <div class="bio">${user.bio ? BB.esc(user.bio) : '<span class="muted">这位玩家还没写简介</span>'}</div>
        <div class="profile-stats">
          <span><b>${BB.num(user.thread_count)}</b> 主题</span>
          <span><b>${BB.num(user.post_count)}</b> 帖子</span>
          <span>加入于 ${BB.datetime(user.created_at).slice(0, 10)}</span>
          <span>最近活跃 ${BB.time(user.last_seen_at) || '很久前'}</span>
        </div>
      </div>
      <div class="profile-actions">
        ${isSelf ? '<a class="btn btn-ghost btn-sm" href="/gallery.html">我的相册</a>' : ''}
        ${isSelf ? '<button class="btn btn-ghost btn-sm" id="editProfileBtn">编辑资料</button>' : ''}
        ${isSelf && user.role === 'admin' ? '<a class="btn btn-ghost btn-sm" href="/admin.html">管理后台</a>' : ''}
      </div>
    </div>`;

  if (isSelf) bindCoverInput('coverInput');

  const tabs = [
    ['threads', `主题 ${data.thread_total}`],
    ['replies', '最近回复'],
  ];
  if (isSelf) tabs.push(['likes', '我赞过的'], ['bookmarks', '我的收藏']);
  document.getElementById('userTabs').innerHTML = tabs
    .map(
      ([key, label]) =>
        `<a href="/user.html?id=${userId}&tab=${key}" class="${key === tab ? 'active' : ''}">${label}</a>`,
    )
    .join('');

  if (isSelf) renderEditPanel(user);
  await renderList(tab, page, userId);

  async function renderList(which, targetPage, id) {
    const host = document.getElementById('userContent');
    if (which === 'likes') {
      const list = await BB.api(`/api/me/likes?page=${targetPage}&per_page=20`);
      host.innerHTML = list.likes.length
        ? `<div class="thread-list">${list.likes
            .map(
              (item) => `
          <div class="thread-row with-snippet">
            ${BB.avatar(item.author, 'avatar-sm')}
            <div class="thread-main">
              <div class="thread-title">
                <a class="row-link" href="/thread.html?id=${item.thread_id}#post-${item.post_id}">${BB.esc(item.thread_title)}</a>
                <span class="chip chip-grey">${item.floor} 楼</span>
              </div>
              <div class="thread-meta">
                ${BB.boardTag(item.board)}
                <span class="dot">·</span>
                <span>${BB.esc(item.author ? item.author.display_name || item.author.username : '未知用户')}</span>
                <span class="dot">·</span>
                <span class="thread-snippet">${BB.esc(item.snippet)}</span>
                <span class="dot">·</span>
                <span>赞于 ${BB.time(item.liked_at)}</span>
              </div>
            </div>
          </div>`,
            )
            .join('')}</div>`
        : '<div class="empty">还没有赞过别人的楼层。帖子里的 👍 会把点赞记录到这里。</div>';
      document.getElementById('listHint').textContent = `共 ${list.pagination.total} 条`;
      document.getElementById('pager').innerHTML = BB.pagination(
        list.pagination,
        (target) => `/user.html?id=${id}&tab=likes&page=${target}`,
      );
      return;
    }
    if (which === 'bookmarks') {
      const list = await BB.api(`/api/me/bookmarks?page=${targetPage}&per_page=20`);
      host.innerHTML = list.threads.length
        ? `<div class="thread-list">${list.threads.map((thread) => BB.threadRow(thread)).join('')}</div>`
        : '<div class="empty">还没有收藏。主题右上角的「☆ 收藏」可以把帖子存到这里。</div>';
      document.getElementById('listHint').textContent = `共 ${list.pagination.total} 条收藏`;
      document.getElementById('pager').innerHTML = BB.pagination(
        list.pagination,
        (target) => `/user.html?id=${id}&tab=bookmarks&page=${target}`,
      );
      return;
    }
    if (which === 'threads') {
      const list = await BB.api(`/api/users/${id}/threads?page=${targetPage}&per_page=20`);
      host.innerHTML = list.threads.length
        ? `<div class="thread-list">${list.threads.map((thread) => BB.threadRow(thread)).join('')}</div>`
        : '<div class="empty">还没有发过主题</div>';
      document.getElementById('listHint').textContent = `共 ${list.pagination.total} 个主题`;
      document.getElementById('pager').innerHTML = BB.pagination(
        list.pagination,
        (target) => `/user.html?id=${id}&tab=threads&page=${target}`,
      );
    } else {
      const list = await BB.api(`/api/users/${id}/posts?page=${targetPage}&per_page=20`);
      host.innerHTML = list.posts.length
        ? `<div class="thread-list">${list.posts
            .map(
              (reply) => `
          <div class="thread-row with-snippet">
            <div class="thread-main">
              <div class="thread-title">
                <a class="row-link" href="/thread.html?id=${reply.thread_id}">回复了「${BB.esc(reply.thread_title)}」</a>
              </div>
              <div class="thread-meta">
                ${BB.boardTag(reply.board)}
                <span class="dot">·</span>
                <span class="thread-snippet">${BB.esc(reply.snippet)}</span>
                <span class="dot">·</span>
                <span>${BB.time(reply.created_at)}</span>
              </div>
            </div>
          </div>`,
            )
            .join('')}</div>`
        : '<div class="empty">还没有回复过别人</div>';
      document.getElementById('listHint').textContent = `共 ${list.pagination.total} 条回复`;
      document.getElementById('pager').innerHTML = BB.pagination(
        list.pagination,
        (target) => `/user.html?id=${id}&tab=replies&page=${target}`,
      );
    }
  }

  function renderEditPanel(currentUser) {
    const host = document.getElementById('editHost');
    host.innerHTML = `
      <section class="card composer hidden" id="editPanel" style="margin-top: 16px">
        <h3>编辑资料</h3>
        <div id="editError"></div>
        <div class="field">
          <label>昵称</label>
          <input class="input" id="displayNameInput" maxlength="24" value="${BB.esc(currentUser.display_name || '')}" placeholder="显示在帖子上的名字">
        </div>
        <div class="field">
          <label>个人简介</label>
          <textarea class="textarea" id="bioInput" maxlength="300" style="min-height: 90px" placeholder="介绍一下自己，比如常玩的版本和整合包">${BB.esc(
            currentUser.bio || '',
          )}</textarea>
        </div>
        <div class="field">
          <label>邮箱（可选，仅用于联系）</label>
          <input class="input" id="emailInput" maxlength="120" value="${BB.esc(currentUser.email || '')}" placeholder="you@example.com">
        </div>
        <div class="composer-foot" style="flex-wrap: wrap">
          <span class="muted">头像 / 封面支持 PNG、JPG、WebP、GIF，上传前可以先拖动裁切</span>
          <label class="btn btn-ghost btn-sm" style="cursor:pointer">
            换头像
            <input type="file" id="avatarInput" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
          </label>
          <label class="btn btn-ghost btn-sm" style="cursor:pointer">
            ${currentUser.cover ? '换封面' : '上传封面'}
            <input type="file" id="coverInputPanel" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
          </label>
          ${currentUser.cover ? '<button class="btn btn-ghost btn-sm" id="removeCoverBtn">删除封面</button>' : ''}
          <button class="btn btn-primary btn-sm" id="saveProfileBtn">保存资料</button>
        </div>
      </section>

      <section class="card composer hidden" id="passwordPanel" style="margin-top: 16px">
        <h3>修改密码</h3>
        <div id="passwordError"></div>
        <div class="form-row">
          <div class="field">
            <label>当前密码</label>
            <input class="input" id="currentPassword" type="password" autocomplete="current-password">
          </div>
          <div class="field">
            <label>新密码</label>
            <input class="input" id="newPassword" type="password" autocomplete="new-password">
          </div>
        </div>
        <div class="composer-foot">
          <span class="muted">改完密码后其他设备需要重新登录</span>
          <button class="btn btn-primary btn-sm" id="savePasswordBtn">更新密码</button>
        </div>
      </section>`;

    document.getElementById('editProfileBtn').addEventListener('click', () => {
      const panel = document.getElementById('editPanel');
      const passwordPanel = document.getElementById('passwordPanel');
      panel.classList.toggle('hidden');
      passwordPanel.classList.toggle('hidden', panel.classList.contains('hidden'));
      if (!panel.classList.contains('hidden')) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    document.getElementById('saveProfileBtn').addEventListener('click', async () => {
      const errorHost = document.getElementById('editError');
      try {
        const updated = await BB.api('/api/me', {
          method: 'PATCH',
          body: {
            display_name: document.getElementById('displayNameInput').value,
            bio: document.getElementById('bioInput').value,
            email: document.getElementById('emailInput').value,
          },
        });
        BB.state.me = updated.user;
        BB.toast('资料已保存', 'ok');
        setTimeout(() => location.reload(), 500);
      } catch (error) {
        BB.showError(errorHost, error.message);
      }
    });

    document.getElementById('avatarInput').addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) {
        BB.toast('图片太大了，请选 8 MB 以内的图片', 'error');
        return;
      }
      // 先让用户拖拽/缩放裁成方形，再上传压缩后的 256px PNG
      const cropped = await BB.cropSquare(file, { size: 256 });
      event.target.value = '';
      if (!cropped) return;
      try {
        await BB.api('/api/me/avatar', {
          method: 'POST',
          raw: true,
          headers: { 'content-type': 'image/png' },
          body: cropped,
        });
        BB.toast('头像已更新', 'ok');
        setTimeout(() => location.reload(), 400);
      } catch (error) {
        BB.toast(error.message, 'error');
      }
    });

    document.getElementById('savePasswordBtn').addEventListener('click', async () => {
      const errorHost = document.getElementById('passwordError');
      const currentPassword = document.getElementById('currentPassword').value;
      const newPassword = document.getElementById('newPassword').value;
      if (newPassword.length < 6) {
        BB.showError(errorHost, '新密码至少 6 位');
        return;
      }
      try {
        await BB.api('/api/me/password', {
          method: 'POST',
          body: { current_password: currentPassword, new_password: newPassword },
        });
        BB.toast('密码已更新', 'ok');
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
      } catch (error) {
        BB.showError(errorHost, error.message);
      }
    });

    // 编辑面板里的封面：上传 / 删除
    bindCoverInput('coverInputPanel');
    const removeCoverBtn = document.getElementById('removeCoverBtn');
    if (removeCoverBtn) {
      removeCoverBtn.addEventListener('click', async () => {
        try {
          await BB.api('/api/me/cover', { method: 'DELETE' });
          BB.toast('封面已删除', 'ok');
          setTimeout(() => location.reload(), 400);
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    }
  }

  /** 选图 → 裁成 3:1 横图 → 上传；个人主页封面按钮和编辑面板共用 */
  function bindCoverInput(id) {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      if (file.size > 12 * 1024 * 1024) {
        BB.toast('图片太大了，请选 12 MB 以内的图片', 'error');
        return;
      }
      const cropped = await BB.cropCover(file);
      if (!cropped) return;
      try {
        await BB.api('/api/me/cover', {
          method: 'POST',
          raw: true,
          headers: { 'content-type': 'image/png' },
          body: cropped,
        });
        BB.toast('封面已更新', 'ok');
        setTimeout(() => location.reload(), 400);
      } catch (error) {
        BB.toast(error.message, 'error');
      }
    });
  }
});
