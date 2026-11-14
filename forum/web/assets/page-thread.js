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

  // 插件帖 / 投影帖是资源详情页：没有楼层、没有楼中楼，只有一个平铺的评论区。
  // 判断口径与启动器一致：帖子上挂了插件或投影，或者本来就在「插件分享 / 投影分享」板块。
  const RESOURCE_BOARDS = new Set(['plugin-share', 'schematic-share']);
  const isResourceThread = (thread) =>
    !!(thread && (thread.plugin || thread.schematic)) ||
    !!(thread && thread.board && RESOURCE_BOARDS.has(thread.board.slug));

  const canEditPost = (post) => !!me && !post.deleted && (me.id === post.author.id || BB.isAdmin());

  // ---------------------------------------------------------------- 渲染

  function likeButton(post) {
    const liked = post.liked ? ' liked' : '';
    return `<button type="button" class="act${liked}" data-act="like" data-post="${post.id}" title="给这一楼点个赞">
      <span class="act-ico">👍</span><span data-like-count>${post.likes || 0}</span>
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
          ${author.role === 'admin' ? '<span class="chip chip-grey">管理员</span>' : author.role === 'moderator' ? '<span class="chip chip-grey">次级管理员</span>' : ''}
          <span class="child-time">${BB.time(child.created_at)}</span>
          <span class="floor">#${child.floor}</span>
        </div>
        <div class="child-content">${
          child.deleted ? '<span class="deleted">该楼层已删除</span>' : BB.md(child.content)
        }</div>
        <div class="child-actions">
          ${child.deleted ? '' : `<button type="button" class="act" data-act="reply" data-post="${child.id}">回复</button>`}
          ${child.deleted ? '' : likeButton(child)}
          ${!child.deleted && !mine && me ? `<button type="button" class="act" data-act="report" data-post="${child.id}">举报</button>` : ''}
          ${mine && !child.deleted ? `<button type="button" class="act danger" data-act="delete-child" data-post="${child.id}">删除</button>` : ''}
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
    const isOp = post.floor === 1;

    return `<article class="post${isOp ? ' is-op' : ''}" id="post-${post.id}" data-post-id="${post.id}">
      <div class="post-side">
        ${BB.avatar(author)}
        <a class="name" href="/user.html?id=${author.id}">${BB.esc(name)}</a>
        <div class="role">${author.role === 'admin' ? '<span class="chip chip-grey">管理员</span>' : author.role === 'moderator' ? '<span class="chip chip-grey">次级管理员</span>' : ''}</div>
        <div class="counts">
          <span>${BB.num(author.post_count || 0)} 帖 · ${BB.num(author.thread_count || 0)} 主题</span>
          ${joined ? `<span>${joined}</span>` : ''}
        </div>
      </div>
      <div class="post-body">
        <div class="post-head">
          ${isOp ? '<span class="chip chip-op">楼主</span>' : ''}
          <span class="post-time" title="${BB.datetime(post.created_at)}">${BB.time(post.created_at)}</span>
          ${post.edit_count > 0 ? '<span class="edited">已编辑</span>' : ''}
          <span class="floor">${post.floor} 楼</span>
        </div>
        <div class="post-content">${
          post.deleted ? '<span class="deleted">该楼层已被作者或管理员删除</span>' : BB.md(post.content)
        }</div>
        <div class="post-actions">
          ${post.deleted ? '' : `<button type="button" class="act" data-act="reply" data-post="${post.id}">回复</button>`}
          ${post.deleted ? '' : `<button type="button" class="act" data-act="quote" data-post="${post.id}">引用</button>`}
          ${post.deleted ? '' : likeButton(post)}
          <button type="button" class="act" data-act="copy-link" data-post="${post.id}">复制链接</button>
          <span class="act-gap"></span>
          ${canEditPost(post) ? `<button type="button" class="act" data-act="edit" data-post="${post.id}">编辑</button>` : ''}
          ${!post.deleted && !mine && me ? `<button type="button" class="act" data-act="report" data-post="${post.id}">举报</button>` : ''}
          ${canEditPost(post) ? `<button type="button" class="act danger" data-act="delete" data-post="${post.id}">删除</button>` : ''}
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

  // ---------------------------------------------------------------- 评论区

  function commentHtml(comment) {
    const author = comment.author || {};
    const mine = me && me.id === author.id;
    const canDelete = !!me && (mine || BB.isAdmin());
    const name = author.display_name || author.username || '未知用户';
    const role = author.role === 'admin' ? '管理员' : author.role === 'moderator' ? '次级管理员' : '';
    return `<article class="comment card" id="comment-${comment.id}" data-comment-id="${comment.id}">
      <div class="comment-head">
        ${BB.avatar(author, 'avatar-sm')}
        <div class="comment-who">
          <a class="name" href="/user.html?id=${author.id}">${BB.esc(name)}</a>
          ${role ? `<span class="chip chip-grey">${role}</span>` : ''}
          <span class="comment-time" title="${BB.datetime(comment.created_at)}">${BB.time(comment.created_at)}</span>
        </div>
        <button type="button" class="comment-like${comment.liked ? ' liked' : ''}" data-act="comment-like" data-comment="${comment.id}" title="给这条评论点个赞">
          <span class="act-ico">👍</span><span data-like-count>${comment.likes || 0}</span>
        </button>
      </div>
      <div class="comment-content post-content">${BB.md(comment.content)}</div>
      <div class="comment-actions">
        <button type="button" class="act" data-act="comment-reply" data-comment="${comment.id}">回复</button>
        ${canDelete ? `<button type="button" class="act danger" data-act="comment-delete" data-comment="${comment.id}">删除</button>` : ''}
        ${!mine && me ? `<button type="button" class="act" data-act="comment-report" data-comment="${comment.id}">举报</button>` : ''}
      </div>
    </article>`;
  }

  function bindCommentActions() {
    document.querySelectorAll('[data-act^="comment-"]').forEach((button) => {
      const commentId = Number(button.dataset.comment);
      if (!commentId) return;
      const action = button.dataset.act;

      if (action === 'comment-like') {
        button.addEventListener('click', async () => {
          if (!me) {
            location.href = BB.loginLink();
            return;
          }
          try {
            const result = await BB.api(`/api/comments/${commentId}/like`, { method: 'POST', body: {} });
            button.classList.toggle('liked', result.liked);
            const count = button.querySelector('[data-like-count]');
            if (count) count.textContent = result.likes;
          } catch (error) {
            BB.toast(error.message, 'error');
          }
        });
        return;
      }

      if (action === 'comment-reply') {
        button.addEventListener('click', () => {
          if (!me) {
            location.href = BB.loginLink();
            return;
          }
          const box = document.getElementById('commentBox');
          const card = document.getElementById('commentComposerCard');
          if (!box) return;
          // 评论没有楼中楼：回复就是在自己的评论里 @ 对方
          const name = (button.closest('.comment')?.querySelector('.comment-who .name')?.textContent || '').trim();
          const prefix = name ? `@${name} ` : '';
          if (!prefix || !box.value.includes(prefix)) {
            box.value = `${prefix}${box.value}`;
            box.focus();
            box.setSelectionRange(box.value.length, box.value.length);
            box.dispatchEvent(new Event('input'));
          }
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        return;
      }

      if (action === 'comment-delete') {
        button.addEventListener('click', async () => {
          if (!confirm('确定删除这条评论吗？')) return;
          try {
            await BB.api(`/api/comments/${commentId}`, { method: 'DELETE' });
            BB.toast('评论已删除', 'ok');
            location.reload();
          } catch (error) {
            BB.toast(error.message, 'error');
          }
        });
        return;
      }

      if (action === 'comment-report') {
        button.addEventListener('click', async () => {
          if (!me) {
            location.href = BB.loginLink();
            return;
          }
          const reason = prompt('举报理由（例如：广告、人身攻击、刷屏）', '');
          if (reason === null) return;
          try {
            await BB.api(`/api/comments/${commentId}/report`, { method: 'POST', body: { reason } });
            BB.toast('已提交举报，管理员会尽快处理', 'ok');
          } catch (error) {
            BB.toast(error.message, 'error');
          }
        });
      }
    });
  }

  /** 评论区的发表框：登录 / 答题 / 锁定三种前置状态和楼层回复框一致 */
  function renderCommentComposer(thread) {
    const host = document.getElementById('composerHost');
    if (!me) {
      host.innerHTML = `<section class="card composer">
        <h3>来说两句？</h3>
        <p class="muted small" style="margin-bottom: 12px">登录后就能评论这个资源，也可以用同一账号在方块盒子论坛发帖。</p>
        <div class="composer-foot"><a class="btn btn-primary" href="${BB.loginLink()}">登录 / 注册</a></div>
      </section>`;
      return;
    }

    if (!me.quiz_passed) {
      host.innerHTML = `<section class="card composer">
        <h3>先通过入站答题，再来评论</h3>
        <p class="muted small" style="margin-bottom: 12px">答题结果记在你的账号上：随机抽 50 题、80 分通过，答错会立刻给出答案和解析。</p>
        <div class="composer-foot"><a class="btn btn-primary" href="/quiz.html?next=${encodeURIComponent(
          `/thread.html?id=${thread.id}`,
        )}">去答题</a></div>
      </section>`;
      return;
    }

    if (thread.locked && !BB.isAdmin()) {
      host.innerHTML = `<section class="card composer">
        <h3>主题已锁定</h3>
        <p class="muted small">这个主题已由管理员锁定，暂时不能评论。</p>
      </section>`;
      return;
    }

    host.innerHTML = `<section class="card composer" id="commentComposerCard">
      <div class="composer-head">
        ${BB.avatar(me, 'avatar-sm')}
        <h3>发表评论</h3>
        <span class="composer-hint">支持 Markdown · 可直接粘贴图片</span>
      </div>
      <div id="commentComposerError"></div>
      <textarea class="textarea" id="commentBox" placeholder="看过之后想说点什么…支持 Markdown：**加粗**、\`代码\`，也能直接粘贴或拖入图片" style="min-height:110px"></textarea>
      <div class="composer-foot">
        <span class="muted small">以 ${BB.esc(me.display_name || me.username)} 的身份评论 · 草稿自动保存 · Ctrl + Enter 发送</span>
        <span class="composer-count" id="commentCount">0 字</span>
        <button class="btn btn-primary" id="commentSubmit">发表评论</button>
      </div>
    </section>`;

    const box = document.getElementById('commentBox');
    const errorHost = document.getElementById('commentComposerError');
    const submit = document.getElementById('commentSubmit');
    const counter = document.getElementById('commentCount');

    const updateCount = () => {
      if (counter) counter.textContent = `${[...box.value.trim()].length} 字`;
    };

    const sendComment = async () => {
      const content = box.value.trim();
      if (!content) {
        BB.showError(errorHost, '评论内容不能为空');
        return;
      }
      submit.disabled = true;
      submit.textContent = '发送中…';
      try {
        const result = await BB.api(`/api/threads/${thread.id}/comments`, {
          method: 'POST',
          body: { content },
        });
        BB.draft.clear(`comment:${thread.id}`);
        const newId = result && result.comment ? result.comment.id : 0;
        location.href = `/thread.html?id=${thread.id}${newId ? `#comment-${newId}` : ''}`;
      } catch (error) {
        BB.showError(errorHost, error.message);
        submit.disabled = false;
        submit.textContent = '发表评论';
      }
    };

    const insertImageFiles = BB.attachImagePaste(box);
    BB.attachMentions(box);
    BB.bindDraft(box, `comment:${thread.id}`);
    BB.attachMarkdownEditor(box, { imageFiles: insertImageFiles });

    box.addEventListener('input', updateCount);
    box.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        sendComment();
      }
    });
    submit.addEventListener('click', sendComment);
    updateCount();
  }

  function renderHead(thread) {
    const flags = `${thread.pinned ? '<span class="chip chip-warn">置顶</span>' : ''}${
      thread.locked ? '<span class="chip chip-grey">已锁定</span>' : ''
    }`;
    const tags = (thread.tags || [])
      .map(
        (tag) =>
          `<a class="tag" href="/board.html?slug=${encodeURIComponent(thread.board.slug)}&tag=${encodeURIComponent(tag)}">#${BB.esc(tag)}</a>`,
      )
      .join('');

    const adminActions = BB.isAdmin()
      ? `<div class="post-actions thread-admin">
           <button type="button" class="act" data-admin="pin">${thread.pinned ? '取消置顶' : '置顶'}</button>
           <button type="button" class="act" data-admin="lock">${thread.locked ? '取消锁定' : '锁定'}</button>
           <button type="button" class="act danger" data-admin="delete">删除主题</button>
         </div>`
      : '';

    const bookmark = me
      ? `<button type="button" class="btn btn-ghost btn-sm bookmark-btn${thread.bookmarked ? ' active' : ''}" data-bookmark="${thread.id}">
           ${thread.bookmarked ? '★ 已收藏' : '☆ 收藏'}
         </button>`
      : `<a class="btn btn-ghost btn-sm bookmark-btn" href="${BB.loginLink()}">☆ 收藏</a>`;

    const resource = isResourceThread(thread);
    const countLine = resource
      ? `<span>${BB.num(thread.comment_count || 0)} 条评论</span>`
      : `<span>${BB.num(thread.reply_count || 0)} 条回复</span>`;

    document.getElementById('threadHead').innerHTML = `
      ${flags ? `<div class="thread-flags">${flags}</div>` : ''}
      <h1>${BB.esc(thread.title)}</h1>
      <div class="meta">
        ${BB.boardTag(thread.board)}
        <a class="meta-author" href="/user.html?id=${thread.author.id}">
          ${BB.avatar(thread.author, 'avatar-xs')}
          <span>${BB.esc(thread.author.display_name)}</span>
        </a>
        <span class="meta-dot">·</span>
        <span>发布于 ${BB.datetime(thread.created_at)}</span>
        <span class="meta-dot">·</span>
        <span>${BB.num(thread.views)} 次浏览</span>
        <span class="meta-dot">·</span>
        ${countLine}
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

  // ---------------------------------------------------------------- 右侧栏

  async function renderRail(thread, { resource = false } = {}) {
    const rail = document.getElementById('threadRail');
    if (!rail) return;
    const board = thread.board || {};
    const lockedNote = thread.locked
      ? `<div class="rail-note">该主题已锁定，暂不接受新${resource ? '评论' : '回复'}</div>`
      : '';

    rail.innerHTML = `
      <section class="card rail-card">
        <h3 class="rail-title">主题信息</h3>
        <div class="rail-stats">
          <div><b>${BB.num(thread.views)}</b><span>浏览</span></div>
          <div><b>${BB.num(resource ? thread.comment_count || 0 : thread.reply_count || 0)}</b><span>${
            resource ? '评论' : '回复'
          }</span></div>
        </div>
        <div class="rail-info">
          <div class="row"><span class="k">版块</span><span class="v"><a href="/board.html?slug=${encodeURIComponent(
            board.slug,
          )}">${board.icon ? `${board.icon} ` : ''}${BB.esc(board.name)}</a></span></div>
          <div class="row"><span class="k">楼主</span><span class="v"><a href="/user.html?id=${
            thread.author.id
          }">${BB.esc(thread.author.display_name)}</a></span></div>
          <div class="row"><span class="k">发布</span><span class="v">${BB.datetime(thread.created_at)}</span></div>
          <div class="row"><span class="k">${resource ? '最后活动' : '最后回复'}</span><span class="v">${BB.time(thread.last_post_at) || '—'}</span></div>
        </div>
        ${lockedNote}
        <button type="button" class="rail-share" data-share>复制本页链接</button>
      </section>

      <section class="card rail-card">
        <h3 class="rail-title">同版块主题</h3>
        <div class="rail-list" id="railBoardList"><div class="rail-empty">加载中…</div></div>
      </section>

      <section class="card rail-card">
        <h3 class="rail-title">社区提示</h3>
        <ul class="rail-tips">
          <li>友善交流，就事论事</li>
          <li>提问前先搜一下同类问题</li>
          <li>图片可直接粘贴进回复框</li>
        </ul>
      </section>`;

    const shareButton = rail.querySelector('[data-share]');
    if (shareButton) {
      shareButton.addEventListener('click', () => copyLink(location.href, '本页链接已复制'));
    }

    const list = document.getElementById('railBoardList');
    if (!board.slug || !list) return;
    try {
      const data = await BB.api(`/api/boards/${encodeURIComponent(board.slug)}?sort=latest`);
      const items = (data.threads || []).filter((item) => item.id !== thread.id).slice(0, 5);
      list.innerHTML = items.length
        ? items
            .map(
              (item) => `<a class="rail-thread" href="/thread.html?id=${item.id}">
                <span class="t">${BB.esc(item.title)}</span>
                <span class="m">${BB.esc((item.author && item.author.display_name) || '匿名')} · ${BB.num(
                  item.reply_count,
                )} 回复</span>
              </a>`,
            )
            .join('')
        : '<div class="rail-empty">这个版块还没有其他主题</div>';
    } catch {
      list.innerHTML = '<div class="rail-empty">暂时读不到同版块主题</div>';
    }
  }

  // ---------------------------------------------------------------- 回复框

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

    // 入站答题和账号绑定：没通过的账号先去答题，通过后回来就能回复
    if (!me.quiz_passed) {
      host.innerHTML = `<section class="card composer">
        <h3>先通过入站答题，再来回复</h3>
        <p class="muted small" style="margin-bottom: 12px">答题结果记在你的账号上：随机抽 50 题、80 分通过，答错会立刻给出答案和解析。</p>
        <div class="composer-foot"><a class="btn btn-primary" href="/quiz.html?next=${encodeURIComponent(
          `/thread.html?id=${thread.id}`,
        )}">去答题</a></div>
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
      <div class="composer-head">
        ${BB.avatar(me, 'avatar-sm')}
        <h3>回复主题</h3>
        <span class="composer-hint">支持 Markdown · 可直接粘贴图片</span>
      </div>
      <div id="composerTarget">${replyTargetHtml()}</div>
      <div id="composerError"></div>
      <textarea class="textarea" id="replyBox" placeholder="说点什么…支持 Markdown：**加粗**、\`代码\`、> 引用；输入 @ 可以选人，也能直接粘贴或拖入图片" style="min-height:140px"></textarea>
      <div class="composer-foot">
        <span class="muted small">以 ${BB.esc(me.display_name || me.username)} 的身份回复 · 草稿自动保存 · Ctrl + Enter 发送</span>
        <span class="composer-count" id="replyCount">0 字</span>
        <button class="btn btn-primary" id="replyBtn">发表回复</button>
      </div>
    </section>`;

    const box = document.getElementById('replyBox');
    const errorHost = document.getElementById('composerError');
    const submit = document.getElementById('replyBtn');
    const counter = document.getElementById('replyCount');

    const updateCount = () => {
      if (!counter) return;
      counter.textContent = `${[...box.value.trim()].length} 字`;
    };

    const sendReply = async () => {
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
    };

    const insertImageFiles = BB.attachImagePaste(box);
    BB.attachMentions(box);
    BB.bindDraft(box, `reply:${thread.id}`);
    BB.attachMarkdownEditor(box, { imageFiles: insertImageFiles });
    bindReplyTargetButtons();

    box.addEventListener('input', updateCount);
    box.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        sendReply();
      }
    });
    submit.addEventListener('click', sendReply);

    if (BB.param('quote')) {
      box.value = `> ${BB.param('quote')}\n\n`;
    }
    updateCount();
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
        box.dispatchEvent(new Event('input'));
      }
    }
  }

  // ---------------------------------------------------------------- 复制链接 / 滚动条

  async function copyLink(text, okMessage) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
      }
      BB.toast(okMessage || '链接已复制', 'ok');
    } catch {
      BB.toast('复制失败，可手动复制地址栏链接', 'error');
    }
  }

  function bindScrollChrome() {
    const bar = document.getElementById('readProgress');
    const toTop = document.getElementById('toTop');
    const onScroll = () => {
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      if (toTop) toTop.classList.toggle('show', y > 480);
      if (bar) {
        const span = document.documentElement.scrollHeight - window.innerHeight;
        bar.style.width = `${span > 0 ? Math.min(100, Math.max(0, (y / span) * 100)) : 0}%`;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    if (toTop) {
      toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    }
    onScroll();
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

      if (action === 'copy-link') {
        button.addEventListener('click', () => {
          copyLink(`${location.origin}/thread.html?id=${threadId}#post-${postId}`, '这一楼的链接已复制');
        });
        return;
      }

      button.addEventListener('click', async () => {
        try {
          if (action === 'reply') {
            // 未通过入站答题时回复框不存在，引导去答题
            if (me && !me.quiz_passed) {
              location.href = `/quiz.html?next=${encodeURIComponent(`/thread.html?id=${threadId}`)}`;
              return;
            }
            if (post) setReplyTarget(post);
          } else if (action === 'quote') {
            const box = document.getElementById('replyBox');
            if (!box || !post) return;
            const text = BB.md(post.content);
            const plain = new DOMParser().parseFromString(text, 'text/html').body.innerText || '';
            box.value = `> ${plain.trim().slice(0, 160).replace(/\n+/g, ' ')}\n\n${box.value}`;
            box.focus();
            box.dispatchEvent(new Event('input'));
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
      <div class="edit-actions">
        <button type="button" class="btn btn-primary btn-sm" data-save>保存</button>
        <button type="button" class="btn btn-ghost btn-sm" data-cancel>取消</button>
      </div>`;
    const textarea = element.querySelector('textarea');
    textarea.value = post.content;
    const insertImageFiles = BB.attachImagePaste(textarea);
    BB.attachMentions(textarea);
    BB.attachMarkdownEditor(textarea, { imageFiles: insertImageFiles });
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

    // 插件帖 / 投影帖：没有楼层与楼中楼，正文下面是平铺的评论区
    if (isResourceThread(thread)) {
      const comments = await BB.api(`/api/threads/${threadId}/comments?page=${page}&per_page=20`);
      const list = comments.comments || [];
      document.getElementById('postList').innerHTML = list.length
        ? list.map((comment) => commentHtml(comment)).join('')
        : `<div class="card comment-empty">
             <b>还没有评论</b>
             <p class="muted small">用过的感受、遇到的问题、想提的建议，都可以写在下面。</p>
           </div>`;
      document.getElementById('pager').innerHTML = BB.pagination(
        comments.pagination,
        (target) => `/thread.html?id=${threadId}&page=${target}`,
      );
      renderCommentComposer(thread);
      bindCommentActions();
      renderRail(thread, { resource: true });
    } else {
      document.getElementById('postList').innerHTML = data.posts.map(postHtml).join('');
      document.getElementById('pager').innerHTML = BB.pagination(
        data.pagination,
        (target) => `/thread.html?id=${threadId}&page=${target}`,
      );
      renderComposer(thread);
      bindActions();
      renderRail(thread);
    }

    const hash = location.hash || '';
    const anchor = hash.startsWith('#comment-') ? hash : hash.startsWith('#post-') ? hash : '';
    if (anchor) {
      const target = document.querySelector(anchor);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 2400);
      }
    }
  }

  bindScrollChrome();
  await load();
});
