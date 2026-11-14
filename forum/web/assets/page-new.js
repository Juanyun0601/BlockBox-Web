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

  // 入站答题和账号绑定：没通过的账号先去答题，通过后自动解锁发帖
  if (!BB.state.me.quiz_passed) {
    host.innerHTML = `<div class="card composer">
      <h3>先通过入站答题，再来发帖</h3>
      <p class="muted small" style="margin-bottom: 14px">答题结果记在你的账号上：随机抽 50 题、80 分通过，答错会立刻给出答案和解析。</p>
      <div class="composer-foot">
        <a class="btn btn-primary" href="/quiz.html?next=%2Fnew.html">去答题</a>
      </div>
    </div>`;
    return;
  }

  const boardData = await BB.api('/api/boards');
  // 插件分享 / 投影分享是资源板块：必须带文件，只能从启动器「发布 → 资源」发，
  // 网页普通发帖不列出来，免得发出一个只有标题的资源帖
  const boards = (boardData.boards || []).filter(
    (board) => !['plugin-share', 'schematic-share'].includes(board.slug),
  );
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

  const insertImageFiles = BB.attachImagePaste(contentInput);
  BB.attachMentions(contentInput);
  BB.bindDraft(contentInput, 'new-thread');
  BB.attachMarkdownEditor(contentInput, { imageFiles: insertImageFiles, presets: 'thread' });

  // 正文字数（和回复框一致）
  const contentCount = document.getElementById('contentCount');
  const updateCount = () => {
    if (contentCount) contentCount.textContent = `${[...contentInput.value.trim()].length} 字`;
  };
  contentInput.addEventListener('input', updateCount);
  updateCount();

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
