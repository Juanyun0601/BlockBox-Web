BB.boot(async () => {
  const formCard = document.getElementById('feedbackFormCard');
  const loginCard = document.getElementById('feedbackLoginCard');
  const mineHead = document.getElementById('mineHead');
  const mineList = document.getElementById('mineList');
  const contentEl = document.getElementById('feedbackContent');
  const countEl = document.getElementById('feedbackCount');
  const errorEl = document.getElementById('feedbackError');
  const submitBtn = document.getElementById('feedbackSubmit');
  const refreshBtn = document.getElementById('feedbackRefresh');

  const statusChip = (status) =>
    status === 'resolved'
      ? '<span class="chip">已处理</span>'
      : status === 'ignored'
        ? '<span class="chip chip-grey">已忽略</span>'
        : '<span class="chip chip-warn">待处理</span>';

  const sourceText = (item) => (item.source === 'launcher' ? '启动器' : '网页');

  const escapeMultiline = (value) => BB.esc(value).replace(/\n/g, '<br>');

  function renderMine(data) {
    document.getElementById('pager').innerHTML = BB.pagination(
      data.pagination,
      (target) => `/feedback.html?page=${target}`,
    );

    mineList.innerHTML = data.feedbacks.length
      ? data.feedbacks
          .map(
            (item) => `<div class="feedback-row">
            <div class="feedback-head">
              ${statusChip(item.status)}
              <span class="light small">来自${sourceText(item)}${item.app_version ? ` · v${BB.esc(item.app_version)}` : ''}</span>
              <span class="notif-time">${BB.time(item.created_at)}</span>
            </div>
            <div class="feedback-content">${escapeMultiline(item.content)}</div>
            ${
              item.reply
                ? `<div class="feedback-reply"><b>管理员回复</b>（${BB.time(item.handled_at)}）：${escapeMultiline(item.reply)}</div>`
                : ''
            }
          </div>`,
          )
          .join('')
      : '<div class="empty">还没有提交过反馈。遇到软件问题或想提建议，就在上方告诉我们。</div>';
  }

  async function loadMine(page) {
    mineList.innerHTML = '<div class="skeleton">正在加载…</div>';
    document.getElementById('pager').innerHTML = '';
    try {
      const data = await BB.api(`/api/me/feedbacks?page=${page}&per_page=20`);
      renderMine(data);
    } catch (error) {
      mineList.innerHTML = `<div class="empty">${BB.esc(error.message)}</div>`;
    }
  }

  // ── 反馈模板：点一下套格式，照着填就行 ──
  const TEMPLATES = {
    bug: [
      '【问题】一句话说清遇到了什么：',
      '',
      '【复现步骤】',
      '1. ',
      '2. ',
      '',
      '【期望】正常应该是：',
      '',
      '【实际】结果是：',
      '',
      '【环境】系统与实例版本（如 Windows 11 + 1.20.1）：',
    ].join('\n'),
    feature: [
      '【建议】想要的功能：',
      '',
      '【场景】什么时候会用到、能解决什么问题：',
      '',
      '【参考】其他启动器或软件有没有类似做法：',
    ].join('\n'),
  };

  document.querySelectorAll('#feedbackTpl [data-tpl]').forEach((button) => {
    button.addEventListener('click', () => {
      const tpl = TEMPLATES[button.dataset.tpl];
      if (!tpl) return;
      const current = contentEl.value.trim();
      if (current && current !== tpl && !confirm('套用模板会替换当前已填写的内容，确定吗？')) return;
      contentEl.value = tpl;
      updateCount();
      contentEl.focus();
    });
  });

  // ── 未登录：只给登录引导 ──
  if (!BB.state.me) {
    loginCard.style.display = '';
    mineHead.style.display = 'none';
    mineList.style.display = 'none';
    return;
  }

  // ── 已登录：表单 + 我的反馈 ──
  formCard.style.display = '';
  mineHead.style.display = '';

  const updateCount = () => {
    countEl.textContent = String([...contentEl.value].length);
  };
  contentEl.addEventListener('input', updateCount);

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.style.display = '';
  };
  const hideError = () => {
    errorEl.style.display = 'none';
  };

  submitBtn.addEventListener('click', async () => {
    const content = contentEl.value.trim();
    if ([...content].length < 5) {
      showError('反馈内容至少 5 个字');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '提交中…';
    hideError();
    try {
      await BB.api('/api/feedback', { method: 'POST', body: { content, source: 'web' } });
      contentEl.value = '';
      updateCount();
      BB.toast('反馈已提交，感谢你的反馈！', 'ok');
      await loadMine(1);
    } catch (error) {
      showError(error.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '提交反馈';
    }
  });

  refreshBtn.addEventListener('click', () => loadMine(Math.max(1, Number(BB.param('page') || 1) || 1)));

  await loadMine(Math.max(1, Number(BB.param('page') || 1) || 1));
});
