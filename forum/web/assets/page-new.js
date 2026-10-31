BB.boot(async () => {
  const host = document.getElementById('newHost');
  const errorHost = document.getElementById('formError');

  if (!BB.state.me) {
    host.innerHTML = `<div class="card composer">
      <h3>登录后才能发帖</h3>
      <p class="muted small" style="margin-bottom: 14px">用账号密码登录，或者几十秒注册一个。</p>
      <div class="composer-foot">
        <a class="btn btn-primary" href="${BB.loginLink('/new.html')}">登录 / 注册</a>
      </div>
    </div>`;
    return;
  }

  const boardData = await BB.api('/api/boards');
  const boards = boardData.boards || [];
  const wanted = BB.param('board');
  const select = document.getElementById('boardSelect');
  select.innerHTML = boards
    .map(
      (board) =>
        `<option value="${BB.esc(board.slug)}"${board.slug === wanted ? ' selected' : ''}>${BB.esc(
          board.icon || '💬',
        )} ${BB.esc(board.name)}</option>`,
    )
    .join('');

  const titleInput = document.getElementById('titleInput');
  const contentInput = document.getElementById('contentInput');
  const submit = document.getElementById('submitBtn');

  BB.attachImagePaste(contentInput);
  BB.attachMentions(contentInput);
  BB.bindDraft(contentInput, 'new-thread');

  // ---------------- 标签 ----------------
  const tags = [];
  const tagWrap = document.getElementById('tagWrap');
  const tagInput = document.getElementById('tagInput');

  function renderTags() {
    tagWrap.querySelectorAll('.tag-chip').forEach((chip) => chip.remove());
    tags.forEach((tag, index) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.innerHTML = `#${BB.esc(tag)}<button type="button" aria-label="移除标签">×</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        tags.splice(index, 1);
        renderTags();
      });
      tagWrap.insertBefore(chip, tagInput);
    });
  }

  function commitTag() {
    const value = tagInput.value.trim().replace(/^#+/, '').slice(0, 12);
    tagInput.value = '';
    if (!value) return;
    if (tags.includes(value)) return;
    if (tags.length >= 4) {
      BB.toast('最多 4 个标签', 'error');
      return;
    }
    tags.push(value);
    renderTags();
  }

  tagInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === ',' || event.key === '，') {
      event.preventDefault();
      commitTag();
    } else if (event.key === 'Backspace' && !tagInput.value && tags.length > 0) {
      tags.pop();
      renderTags();
    }
  });
  tagInput.addEventListener('blur', commitTag);

  submit.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const content = contentInput.value.trim();
    if (title.length < 2) {
      BB.showError(errorHost, '标题至少 2 个字');
      titleInput.focus();
      return;
    }
    if (content.length < 2) {
      BB.showError(errorHost, '正文至少 2 个字');
      contentInput.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = '发布中…';
    BB.showError(errorHost, '');
    commitTag();
    try {
      const data = await BB.api('/api/threads', {
        method: 'POST',
        body: { board: select.value, title, content, tags },
      });
      BB.draft.clear('new-thread');
      location.href = `/thread.html?id=${data.id}`;
    } catch (error) {
      BB.showError(errorHost, error.message);
      submit.disabled = false;
      submit.textContent = '发布';
    }
  });
});
