BB.boot(async () => {
  const threadId = Number(BB.param('id'));
  if (!threadId) {
    location.replace('/');
    return;
  }
  const page = Math.max(1, Number(BB.param('page') || 1) || 1);
  const me = BB.state.me;
  let current = null;
  let replyTarget = null;
  const postCache = new Map();

  const canEditPost = (post) => !!me && !post.deleted && (me.id === post.author.id || BB.isAdmin());

  // ---------------------------------------------------------------- 渲染

  function likeButton(post, compact) {
    const liked = post.liked ? ' liked' : '';
    return `<button type="button" class="${compact ? '' : ''}${liked}" data-act="like" data-post="${post.id}">
      👍 <span data-like-count>${post.likes || 0}</span>
    </button>`;
  }

  function childHtml(child) {
    const author = child.author || {};
    const name = author.display_name || author.username || '未知用户';
    const mine = me && me.id === author.id;
    return `<div class="child" data-post-id="${child.id}">
      ${BB.avatar(author, 'avatar-sm')}
      <div class="child-body">
        <div class="child-head">
          <a class="name" href="/user.html?id=${author.id}">${BB.esc(name)}</a>
          ${author.role === 'admin' ? '<span class="chip">管理员</span>' : ''}
          <span>${BB.time(child.created_at)}</span>
          <span class="floor">#${child.floor}</span>
        </div>
        <div class="child-content">${
          child.deleted ? '<span class="deleted">该楼层已删除</span>' : BB.md(child.content)
        }</div>
        <div class="child-actions">
          ${child.deleted ? '' : `<button type="button" data-act="reply" data-post="${child.id}">回复</button>`}
          ${child.deleted ? '' : likeButton(child, true)}
          ${!child.deleted && !mine && me ? `<button type="button" data-act="report" data-post="${child.id}">举报</button>` : ''}
          ${mine && !child.deleted ? `<button type="button" data-act="delete-child" data-post="${child.id}">删除</button>` : ''}
        </div>
      </div>
    </div>`;
  }

  function postHtml(post) {
    const author = post.author || {};
    const mine = me && me.id === author.id;
    const name = author.display_name || author.username || '未知用户';
    const joined = author.joined_at ? `注册于 ${BB.datetime(author.joined_at).slice(0, 10)}` : '';
    const children = post.children || [];
    const visible = children.slice(0, 6);
    const hidden = children.slice(6);
    const hasHidden = hidden.length > 0;

    return `<article class="post" id="post-${post.id}" data-post-id="${post.id}">
      <div class="post-side">
        ${BB.avatar(author)}
        <a class="name" href="/user.html?id=${author.id}">${BB.esc(name)}</a>
        <div class="role">${author.role === 'admin' ? '<span class="chip">管理员</span>' : ''}</div>
        <div class="counts">
          ${BB.num(author.post_count || 0)} 帖 · ${BB.num(author.thread_count || 0)} 主题<br>${joined}
        </div>
      </div>
      <div class="post-body">
        <div class="post-head">
          ${post.floor === 1 ? '<span class="chip">楼主</span>' : ''}
          <span title="${BB.datetime(post.created_at)}">${BB.time(post.created_at)}</span>
          ${post.edit_count > 0 ? '<span class="muted small">已编辑</span>' : ''}
          <span class="floor">${post.floor} 楼</span>
        </div>
        <div class="post-content">${
          post.deleted ? '<span class="deleted">该楼层已被作者或管理员删除</span>' : BB.md(post.content)
        }</div>
        <div class="post-actions">
          ${post.deleted ? '' : `<button type="button" data-act="reply" data-post="${post.id}">回复</button>`}
          ${post.deleted ? '' : likeButton(post, false)}
          ${post.deleted ? '' : `<button type="button" data-act="quote" data-post="${post.id}">引用</button>`}
          ${canEditPost(post) ? `<button type="button" data-act="edit" data-post="${post.id}">编辑</button>` : ''}
          ${canEditPost(post) ? `<button type="button" class="danger" data-act="delete" data-post="${post.id}">删除</button>` : ''}
          ${!post.deleted && !mine && me ? `<button type="button" data-act="report" data-post="${post.id}">举报</button>` : ''}
        </div>
        ${
          children.length
            ? `<div class="children" data-children="${children.length}">
                 ${visible.map((child) => childHtml(child)).join('')}
                 <div class="children-more hidden" data-more>${hidden.map((child) => childHtml(child)).join('')}</div>
                 ${hasHidden ? `<button type="button" class="children-toggle" data-act="toggle-children">查看全部 ${children.length} 条回复</button>` : ''}
               </div>`
            : ''
        }
      </div>
    </article>`;
  }

  function renderHead(thread) {
    const pinned = thread.pinned ? '<span class="chip chip-warn">置顶</span>' : '';
    const locked = thread.locked ? '<span class="chip chip-grey">已锁定</span>' : '';
    const tags = (thread.tags || [])
      .map(
        (tag) =>
          `<a class="tag" href="/board.html?slug=${encodeURIComponent(thread.board.slug)}&tag=${encodeURIComponent(tag)}">#${BB.esc(tag)}</a>`,
      )
      .join('');

    const adminActions = BB.isAdmin()
      ? `<div class="post-actions" style="margin-top: 10px">
           <button type="button" data-admin="pin">${thread.pinned ? '取消置顶' : '置顶'}</button>
           <button type="button" data-admin="lock">${thread.locked ? '取消锁定' : '锁定'}</button>
           <button type="button" class="danger" data-admin="delete">删除主题</button>
         </div>`
      : '';

    const bookmark = me
      ? `<button type="button" class="btn btn-ghost btn-sm bookmark-btn${thread.bookmarked ? ' active' : ''}" data-bookmark="${thread.id}">
           ${thread.bookmarked ? '★ 已收藏' : '☆ 收藏'}
         </button>`
      : `<a class="btn btn-ghost btn-sm" href="${BB.loginLink()}">☆ 收藏</a>`;

    document.getElementById('threadHead').innerHTML = `
      <h1>${pinned}${locked}${BB.esc(thread.title)}</h1>
      <div class="meta">
        ${BB.boardTag(thread.board)}
        <a href="/user.html?id=${thread.author.id}">${BB.esc(thread.author.display_name)}</a>
        <span>· 发布于 ${BB.datetime(thread.created_at)}</span>
        <span>· ${BB.num(thread.views)} 次浏览</span>
        <span>· ${BB.num(thread.reply_count)} 条回复</span>
        ${bookmark}
      </div>
      ${tags ? `<div class="post-tags">${tags}</div>` : ''}
      ${adminActions}`;

    const head = document.getElementById('threadHead');
    const bookmarkButton = head.querySelector('[data-bookmark]');
    if (bookmarkButton) {
      bookmarkButton.addEventListener('click', async () => {
        const result = await BB.toggleBookmark(thread.id);
        if (!result) return;
        thread.bookmarked = result.bookmarked;
        bookmarkButton.classList.toggle('active', result.bookmarked);
        bookmarkButton.textContent = result.bookmarked ? '★ 已收藏' : '☆ 收藏';
        BB.toast(result.bookmarked ? '已收藏，可在个人主页查看' : '已取消收藏', 'ok');
      });
    }

    head.querySelectorAll('[data-admin]').forEach((button) => {
      button.addEventListener('click', async () => {
        const action = button.dataset.admin;
        try {
          if (action === 'pin' || action === 'lock') {
            await BB.api(`/api/admin/threads/${thread.id}`, {
              method: 'PATCH',
              body: action === 'pin' ? { pinned: !thread.pinned } : { locked: !thread.locked },
            });
          } else if (action === 'delete') {
            if (!confirm('确定删除这个主题吗？删除后不可恢复。')) return;
            await BB.api(`/api/threads/${thread.id}`, { method: 'DELETE' });
          }
          location.reload();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    });
  }

  function replyTargetHtml() {
    if (!replyTarget) return '';
    return `<div class="reply-target" id="replyTargetBar">
      <span>正在回复 <b>${BB.esc(replyTarget.name)}</b> 的第 ${replyTarget.floor} 楼</span>
      <button type="button" id="clearReplyTarget">取消</button>
    </div>`;
  }

  function renderComposer(thread) {
    const host = document.getElementById('composerHost');
    if (!me) {
      host.innerHTML = `<section class="card composer">
        <h3>想参与讨论？</h3>
        <p class="muted small" style="margin-bottom: 12px">登录后就能回复这个主题，也可以用同一账号在方块盒子论坛发帖。</p>
        <div class="composer-foot"><a class="btn btn-primary" href="${BB.loginLink()}">登录 / 注册</a></div>
      </section>`;
      return;
    }

    if (thread.locked && !BB.isAdmin()) {
      host.innerHTML = `<section class="card composer">
        <h3>主题已锁定</h3>
        <p class="muted small">这个主题已由管理员锁定，暂时不能回复。</p>
      </section>`;
      return;
    }

    host.innerHTML = `<section class="card composer" id="composerCard">
      <h3>回复主题</h3>
      <div id="composerTarget">${replyTargetHtml()}</div>
      <div id="composerError"></div>
      <textarea class="textarea" id="replyBox" placeholder="说点什么…支持 Markdown：**加粗**、\`代码\`、> 引用；输入 @ 可以选人，也能直接粘贴或拖入图片" style="min-height:140px"></textarea>
      <div class="composer-foot" style="margin-top: 12px">
        <span class="muted">以 ${BB.esc(me.display_name || me.username)} 的身份回复 · 内容会自动保存草稿</span>
        <button class="btn btn-primary" id="replyBtn">发表回复</button>
      </div>
    </section>`;

    const box = document.getElementById('replyBox');
    const errorHost = document.getElementById('composerError');
    const submit = document.getElementById('replyBtn');

    BB.attachImagePaste(box);
    BB.attachMentions(box);
    BB.bindDraft(box, `reply:${thread.id}`);
    bindReplyTargetButtons();

    submit.addEventListener('click', async () => {
      const content = box.value.trim();
      if (!content) {
        BB.showError(errorHost, '回复内容不能为空');
        return;
      }
      submit.disabled = true;
      submit.textContent = '发送中…';
      try {
        await BB.api(`/api/threads/${thread.id}/posts`, {
          method: 'POST',
          body: { content, ...(replyTarget ? { reply_to: replyTarget.id } : {}) },
        });
        BB.draft.clear(`reply:${thread.id}`);
        location.href = replyTarget
          ? `/thread.html?id=${thread.id}#post-${replyTarget.id}`
          : `/thread.html?id=${thread.id}&page=${current.pagination.pages}#last`;
      } catch (error) {
        BB.showError(errorHost, error.message);
        submit.disabled = false;
        submit.textContent = '发表回复';
      }
    });

    if (BB.param('quote')) {
      box.value = `> ${BB.param('quote')}\n\n`;
    }
  }

  function bindReplyTargetButtons() {
    const bar = document.getElementById('replyTargetBar');
    if (!bar) return;
    bar.querySelector('#clearReplyTarget').addEventListener('click', () => {
      replyTarget = null;
      document.getElementById('composerTarget').innerHTML = '';
    });
  }

  function setReplyTarget(post) {
    const author = post.author || {};
    replyTarget = {
      id: post.id,
      floor: post.floor,
      name: author.display_name || author.username || '未知用户',
    };
    const host = document.getElementById('composerTarget');
    if (host) host.innerHTML = replyTargetHtml();
    bindReplyTargetButtons();
    const card = document.getElementById('composerCard');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const box = document.getElementById('replyBox');
      if (box) {
        if (!box.value.trim()) box.value = `回复 @${author.username}：`;
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
    }
  }

  // ---------------------------------------------------------------- 交互

  function bindActions() {
    document.querySelectorAll('[data-act]').forEach((button) => {
      const postId = Number(button.dataset.post);
      const action = button.dataset.act;
      if (!postId && action !== 'toggle-children') return;
      const post = postCache.get(postId);

      if (action === 'like') {
        button.addEventListener('click', async () => {
          const result = await BB.likePost(postId);
          if (!result) return;
          button.classList.toggle('liked', result.liked);
          const count = button.querySelector('[data-like-count]');
          if (count) count.textContent = result.likes;
          if (post) {
            post.likes = result.likes;
            post.liked = result.liked;
          }
        });
        return;
      }

      button.addEventListener('click', async () => {
        try {
          if (action === 'reply') {
            if (post) setReplyTarget(post);
          } else if (action === 'quote') {
            const box = document.getElementById('replyBox');
            if (!box || !post) return;
            const text = BB.md(post.content);
            const plain = new DOMParser().parseFromString(text, 'text/html').body.innerText || '';
            box.value = `> ${plain.trim().slice(0, 160).replace(/\n+/g, ' ')}\n\n${box.value}`;
            box.focus();
            setReplyTarget(post);
          } else if (action === 'delete') {
            if (!confirm('确定删除这条回复吗？')) return;
            await BB.api(`/api/posts/${postId}`, { method: 'DELETE' });
            location.reload();
          } else if (action === 'delete-child') {
            if (!confirm('确定删除这条楼中楼回复吗？')) return;
            await BB.api(`/api/posts/${postId}`, { method: 'DELETE' });
            location.reload();
          } else if (action === 'report') {
            await BB.reportPost(postId);
          } else if (action === 'edit') {
            if (post) startEdit(postId);
          } else if (action === 'toggle-children') {
            const container = button.closest('.children');
            const more = container.querySelector('[data-more]');
            const expanded = !more.classList.contains('hidden');
            more.classList.toggle('hidden', expanded);
            button.textContent = expanded ? `查看全部 ${container.dataset.children} 条回复` : '收起回复';
          }
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    });
  }

  function startEdit(postId) {
    const post = postCache.get(postId);
    const element = document.querySelector(`#post-${postId} .post-content`);
    if (!post || !element) return;
    element.innerHTML = `
      <textarea class="textarea" style="min-height:150px"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button type="button" class="btn btn-primary btn-sm" data-save>保存</button>
        <button type="button" class="btn btn-ghost btn-sm" data-cancel>取消</button>
      </div>`;
    const textarea = element.querySelector('textarea');
    textarea.value = post.content;
    textarea.focus();
    element.querySelector('[data-cancel]').addEventListener('click', () => load());
    element.querySelector('[data-save]').addEventListener('click', async () => {
      try {
        await BB.api(`/api/posts/${postId}`, { method: 'PATCH', body: { content: textarea.value } });
        BB.toast('已保存', 'ok');
        load();
      } catch (error) {
        BB.toast(error.message, 'error');
      }
    });
  }

  async function load() {
    const data = await BB.api(`/api/threads/${threadId}?page=${page}&per_page=20`);
    current = data;
    const thread = data.thread;

    document.title = `${thread.title} · 方块盒子论坛`;
    document.getElementById('crumbs').innerHTML = `
      <a href="/">首页</a><span>›</span>
      <a href="/board.html?slug=${encodeURIComponent(thread.board.slug)}">${BB.esc(thread.board.name)}</a>
      <span>›</span><span>${BB.esc(thread.title)}</span>`;

    postCache.clear();
    data.posts.forEach((post) => {
      postCache.set(post.id, post);
      (post.children || []).forEach((child) => postCache.set(child.id, child));
    });

    renderHead(thread);
    document.getElementById('postList').innerHTML = data.posts.map(postHtml).join('');
    document.getElementById('pager').innerHTML = BB.pagination(
      data.pagination,
      (target) => `/thread.html?id=${threadId}&page=${target}`,
    );
    renderComposer(thread);
    bindActions();

    const hash = location.hash || '';
    if (hash.startsWith('#post-')) {
      const target = document.querySelector(hash);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 2400);
      }
    }
  }

  await load();
});
