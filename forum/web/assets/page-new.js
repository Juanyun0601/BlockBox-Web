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

  const TUTORIAL_BOARD = 'tutorial-share';
  const ATTACHMENT_EXTS = ['pdf', 'zip', 'rar', '7z', 'txt', 'md', 'json', 'csv', 'log', 'mp3', 'wav', 'ogg'];
  const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

  const boardData = await BB.api('/api/boards');
  // 插件分享 / 投影分享是资源板块：必须带文件，只能从启动器「发布 → 资源」发；
  // 教程分享只能从上面的「教程」模式发（固定板块 + 附件 + 目录）；有奖问答同理走「问答」模式。
  // 都从普通发帖下拉里隐藏。
  const boards = (boardData.boards || []).filter(
    (board) => !['plugin-share', 'schematic-share', 'tutorial-share', 'qa'].includes(board.slug),
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
  const editor = BB.attachMarkdownEditor(contentInput, { imageFiles: insertImageFiles, presets: 'thread' });

  // ---------------- 帖子 / 教程 / 问答 模式切换 ----------------
  // 教程固定发进「教程分享」板块：不选板块，多出资料附件和目录预览。
  // 问答固定发进「有奖问答」板块：不选板块，多出悬赏金额（发布时就从余额里托管）。
  const modePost = document.getElementById('modePost');
  const modeTutorial = document.getElementById('modeTutorial');
  const modeQuestion = document.getElementById('modeQuestion');
  const modeHint = document.getElementById('modeHint');
  const boardField = document.getElementById('boardField');
  const attachmentField = document.getElementById('attachmentField');
  const tocPreviewField = document.getElementById('tocPreviewField');
  const bountyField = document.getElementById('bountyField');
  const bountyInput = document.getElementById('bountyInput');
  const bountyHint = document.getElementById('bountyHint');
  const bountyPresets = document.getElementById('bountyPresets');
  let mode = wanted === TUTORIAL_BOARD ? 'tutorial' : 'post';
  let myPoints = null;

  // 悬赏快捷金额：点一下就填好，当前金额和按钮对应时按钮高亮
  const syncBountyPresets = () => {
    if (!bountyPresets) return;
    const value = String(Math.floor(Number(bountyInput.value)));
    bountyPresets.querySelectorAll('[data-bounty]').forEach((button) => {
      button.classList.toggle('active', button.dataset.bounty === value);
    });
  };
  if (bountyPresets) {
    bountyPresets.addEventListener('click', (event) => {
      const button = event.target.closest('[data-bounty]');
      if (!button) return;
      bountyInput.value = button.dataset.bounty;
      syncBountyPresets();
    });
  }
  if (bountyInput) bountyInput.addEventListener('input', syncBountyPresets);

  const applyMode = () => {
    const tutorialMode = mode === 'tutorial';
    const questionMode = mode === 'question';
    modePost.classList.toggle('active', mode === 'post');
    modePost.setAttribute('aria-pressed', String(mode === 'post'));
    modeTutorial.classList.toggle('active', tutorialMode);
    modeTutorial.setAttribute('aria-pressed', String(tutorialMode));
    modeQuestion.classList.toggle('active', questionMode);
    modeQuestion.setAttribute('aria-pressed', String(questionMode));
    boardField.classList.toggle('hidden', tutorialMode || questionMode);
    attachmentField.classList.toggle('hidden', !tutorialMode);
    tocPreviewField.classList.toggle('hidden', !tutorialMode);
    bountyField.classList.toggle('hidden', !questionMode);
    modeHint.textContent = tutorialMode
      ? '图文 / 视频教程与攻略：正文标题自动生成目录，支持折叠块、表格、思维导图，B 站链接直接贴进正文。'
      : questionMode
        ? '悬赏方块提问：发布时托管赏金，别人在下面盖楼回答，你采纳哪一层赏金就发给谁。'
        : '交流讨论、求助提问、分享作品，选一个板块发布。';
    titleInput.placeholder = tutorialMode
      ? '一句话说清这篇教程教什么'
      : questionMode
        ? '一句话说清你要问的问题'
        : '一句话说清问题或想聊的内容';
    if (editor && typeof editor.setPresets === 'function') editor.setPresets(tutorialMode ? 'tutorial' : 'thread');
    updateTocPreview();
    if (questionMode) {
      syncBountyPresets();
      loadPoints();
    }
  };
  modePost.addEventListener('click', () => {
    mode = 'post';
    applyMode();
  });
  modeTutorial.addEventListener('click', () => {
    mode = 'tutorial';
    applyMode();
  });
  modeQuestion.addEventListener('click', () => {
    mode = 'question';
    applyMode();
  });

  // 悬赏金额旁边显示当前余额，省得发到一半才发现方块不够
  const loadPoints = async () => {
    if (myPoints !== null) return;
    try {
      const data = await BB.api('/api/points');
      myPoints = Number(data.points) || 0;
      if (bountyHint) {
        bountyHint.innerHTML = `悬赏 1–500 个方块，你现在有 <b>${myPoints}</b> 个。发布时先从余额里扣下来托管，采纳回答后当场到账，30 天没人采纳就按点赞最高的回答自动发放。`;
      }
    } catch {
      /* 余额拿不到也不影响发布，服务端还会再校验一次 */
    }
  };

  // ---------------- 资料附件（教程模式） ----------------
  const attachmentList = document.getElementById('attachmentList');
  const attachmentAdd = document.getElementById('attachmentAdd');
  const attachmentPicker = document.createElement('input');
  attachmentPicker.type = 'file';
  attachmentPicker.multiple = true;
  attachmentPicker.hidden = true;
  document.body.appendChild(attachmentPicker);
  const attachments = []; // { upload_id, name, file_size }

  const renderAttachments = () => {
    attachmentList.innerHTML = attachments
      .map(
        (item, index) => `<span class="attachment-chip">📎 ${BB.esc(item.name)} <i>${Math.max(
          1,
          Math.round(item.file_size / 1024),
        )} KB</i><button type="button" data-index="${index}" aria-label="移除附件">×</button></span>`,
      )
      .join('');
  };

  attachmentList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-index]');
    if (!button) return;
    attachments.splice(Number(button.dataset.index), 1);
    renderAttachments();
  });

  attachmentAdd.addEventListener('click', () => attachmentPicker.click());
  attachmentPicker.addEventListener('change', async () => {
    const files = Array.from(attachmentPicker.files || []);
    attachmentPicker.value = '';
    for (const file of files) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!ATTACHMENT_EXTS.includes(ext)) {
        BB.toast(`不支持 .${ext} 文件，试试 PDF、压缩包或文本类`, 'error');
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        BB.toast(`${file.name} 超过 50MB`, 'error');
        continue;
      }
      if (attachments.length >= 10) {
        BB.toast('资料附件最多 10 个', 'error');
        break;
      }
      BB.toast(`正在上传 ${file.name}…`);
      try {
        const uploaded = await BB.uploadAttachment(file);
        attachments.push({ upload_id: uploaded.upload_id, name: uploaded.name || file.name, file_size: uploaded.file_size || file.size });
        renderAttachments();
        BB.toast(`${file.name} 已添加`, 'ok');
      } catch (error) {
        BB.toast(error.message || '附件上传失败', 'error');
      }
    }
  });

  // ---------------- 目录预览（教程模式） ----------------
  const tocPreview = document.getElementById('tocPreview');
  const updateTocPreview = () => {
    if (mode !== 'tutorial' || !tocPreview) return;
    const toc = BB.tocOf(contentInput.value);
    tocPreview.innerHTML = toc.length
      ? toc
          .map(
            (entry) =>
              `<a class="toc-row toc-level-${entry.level}" href="javascript:void 0" style="pointer-events:none">${BB.esc(entry.text)}</a>`,
          )
          .join('')
      : '<span class="muted small">正文里还没有标题，写上「## 章节名」就会出现在这里。</span>';
  };
  contentInput.addEventListener('input', () => updateTocPreview());
  applyMode();

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

    // 问答模式的赏金：1~500 的整数，发布时服务端会直接从余额里扣下来托管
    let bounty = 0;
    if (mode === 'question') {
      bounty = Math.floor(Number(bountyInput.value));
      if (!Number.isInteger(bounty) || bounty < 1 || bounty > 500) {
        BB.showError(errorHost, '悬赏金额要填 1–500 之间的整数');
        bountyInput.focus();
        return;
      }
      if (myPoints !== null && bounty > myPoints) {
        BB.showError(errorHost, `方块不够：你现在有 ${myPoints} 个，悬赏要 ${bounty} 个`);
        return;
      }
    }

    submit.disabled = true;
    submit.textContent = '发布中…';
    BB.showError(errorHost, '');
    commitTag();
    try {
      const body =
        mode === 'tutorial'
          ? {
              board: TUTORIAL_BOARD,
              title,
              content,
              tags,
              tutorial: true,
              attachment_ids: attachments.map((item) => item.upload_id),
            }
          : mode === 'question'
            ? { title, content, tags, question: true, bounty }
            : { board: select.value, title, content, tags };
      const data = await BB.api('/api/threads', { method: 'POST', body });
      BB.draft.clear('new-thread');
      location.href = `/thread.html?id=${data.id}`;
    } catch (error) {
      BB.showError(errorHost, error.message);
      submit.disabled = false;
      submit.textContent = '发布';
    }
  });
});
