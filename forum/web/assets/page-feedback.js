BB.boot(async () => {
  const formCard = document.getElementById('feedbackFormCard');
  const loginCard = document.getElementById('feedbackLoginCard');
  const mineHead = document.getElementById('mineHead');
  const mineList = document.getElementById('mineList');
  const errorEl = document.getElementById('feedbackError');
  const submitBtn = document.getElementById('feedbackSubmit');
  const refreshBtn = document.getElementById('feedbackRefresh');

  const appVersionEl = document.getElementById('feedbackAppVersion');
  const platformEl = document.getElementById('feedbackPlatform');
  const osVersionEl = document.getElementById('feedbackOsVersion');
  const descEl = document.getElementById('feedbackDesc');
  const descLabel = document.getElementById('descLabel');
  const stepsEl = document.getElementById('feedbackSteps');
  const expectedEl = document.getElementById('feedbackExpected');
  const actualEl = document.getElementById('feedbackActual');
  const logsEl = document.getElementById('feedbackLogs');
  const screenshotsEl = document.getElementById('feedbackScreenshots');
  const sceneFieldEl = document.getElementById('fieldScene');
  const sceneEl = document.getElementById('feedbackScene');

  const statusChip = (status) =>
    status === 'resolved'
      ? '<span class="chip">已处理</span>'
      : status === 'ignored'
        ? '<span class="chip chip-grey">已忽略</span>'
        : '<span class="chip chip-warn">待处理</span>';

  const typeText = (type) => (type === 'feature' ? '功能建议' : '问题反馈');
  const sourceText = (item) => (item.source === 'launcher' ? '启动器' : '网页');

  // 正文里的 GitHub 模板标题（### xxx）渲染成加粗小标题
  const escapeMultiline = (value) =>
    BB.esc(value)
      .replace(/^### (.+)$/gm, '<b>$1</b>')
      .replace(/\n/g, '<br>');

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
              <span class="chip chip-grey">${typeText(item.type)}</span>
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

  // ────────────────────────── 全部反馈（仿 GitHub Issues 列表页，公开） ──────────────────────────

  const allTabs = document.getElementById('allTabs');
  const allList = document.getElementById('allList');
  let allStatus = 'all';
  let allCounts = { open: 0, resolved: 0, ignored: 0 };

  /** GitHub 风格的状态胶囊：待处理绿 / 已处理紫 / 已忽略灰 */
  const statePill = (status) =>
    status === 'resolved'
      ? '<span class="fb-state fb-state-resolved">已处理</span>'
      : status === 'ignored'
        ? '<span class="fb-state fb-state-ignored">已忽略</span>'
        : '<span class="fb-state fb-state-open">待处理</span>';

  function renderAllTabs() {
    allTabs.innerHTML = [
      ['all', `全部 ${(allCounts.open || 0) + (allCounts.resolved || 0) + (allCounts.ignored || 0)}`],
      ['open', `待处理 ${allCounts.open || 0}`],
      ['resolved', `已处理 ${allCounts.resolved || 0}`],
      ['ignored', `已忽略 ${allCounts.ignored || 0}`],
    ]
      .map(
        ([value, label]) =>
          `<button type="button" class="fb-tab${allStatus === value ? ' active' : ''}" data-status="${value}">${label}</button>`,
      )
      .join('');
    allTabs.querySelectorAll('[data-status]').forEach((button) => {
      button.addEventListener('click', () => {
        if (allStatus === button.dataset.status) return;
        allStatus = button.dataset.status;
        renderAllTabs();
        loadAll(1);
      });
    });
  }

  function renderAll(data) {
    allCounts = data.counts || allCounts;
    renderAllTabs();

    document.getElementById('allPager').innerHTML = BB.pagination(
      data.pagination,
      (target) => `/feedback.html?page=${target}`,
    );

    allList.innerHTML = data.feedbacks.length
      ? data.feedbacks
          .map((item) => {
            const author = item.user ? BB.esc(item.user.display_name || item.user.username) : '已注销用户';
            const handled = item.handled_at
              ? ` · ${item.status === 'ignored' ? '已忽略' : '已处理于'} ${BB.time(item.handled_at)}`
              : '';
            return `<div class="fb-issue">
            <div class="fb-issue-head" data-expand="${item.id}">
              <div class="fb-issue-title-row">
                ${statePill(item.status)}
                <span class="fb-issue-title">${BB.esc(item.title)}</span>
                <span class="chip chip-grey">${typeText(item.type)}</span>
              </div>
              <div class="fb-issue-meta">#${item.id} 由 ${author} 提交 · ${BB.time(item.created_at)}${handled}</div>
            </div>
            <div class="fb-issue-detail" style="display: none">
              <div class="feedback-content">${escapeMultiline(item.content)}</div>
              ${
                item.reply
                  ? `<div class="feedback-reply"><b>管理员回复</b>（${BB.time(item.handled_at)}）：${escapeMultiline(item.reply)}</div>`
                  : ''
              }
            </div>
          </div>`;
          })
          .join('')
      : '<div class="empty">还没有人提交过反馈，来当第一个吧。</div>';

    // 点行头展开 / 收起详情
    allList.querySelectorAll('[data-expand]').forEach((head) => {
      head.addEventListener('click', () => {
        const detail = head.parentElement.querySelector('.fb-issue-detail');
        detail.style.display = detail.style.display === 'none' ? '' : 'none';
        head.parentElement.classList.toggle('expanded', detail.style.display !== 'none');
      });
    });
  }

  async function loadAll(page) {
    allList.innerHTML = '<div class="skeleton">正在加载…</div>';
    document.getElementById('allPager').innerHTML = '';
    try {
      const data = await BB.api(`/api/feedbacks?status=${allStatus}&page=${page}&per_page=20`);
      renderAll(data);
    } catch (error) {
      allList.innerHTML = `<div class="empty">${BB.esc(error.message)}</div>`;
    }
  }

  // ── 公开列表所有人可见（含未登录访客） ──
  await loadAll(Math.max(1, Number(BB.param('page') || 1) || 1));

  // ── 未登录：表单区只给登录引导 ──
  if (!BB.state.me) {
    loginCard.style.display = '';
    mineHead.style.display = 'none';
    mineList.style.display = 'none';
    return;
  }

  // ── 已登录：表单 + 我的反馈 ──
  formCard.style.display = '';
  mineHead.style.display = '';

  let currentType = 'bug';

  /** 按类型显示对应字段：问题反馈与 GitHub Issue 模板一致，功能建议只要建议内容 */
  function applyType(type) {
    currentType = type;
    const isBug = type === 'bug';
    descLabel.textContent = isBug ? '问题描述' : '建议内容';
    descEl.placeholder = isBug
      ? '说说发生了什么，涉及哪个页面、哪个实例，越具体越好。'
      : '想要什么功能，一句话说清。';
    for (const id of ['fieldAppVersion', 'fieldPlatform', 'fieldOsVersion', 'fieldSteps', 'fieldExpected', 'fieldActual', 'fieldLogs', 'fieldScreenshots']) {
      document.getElementById(id).style.display = isBug ? '' : 'none';
    }
    sceneFieldEl.style.display = isBug ? 'none' : '';
    document.querySelectorAll('#feedbackType [data-type]').forEach((button) => {
      const active = button.dataset.type === type;
      button.classList.toggle('btn-primary', active);
      button.classList.toggle('btn-ghost', !active);
    });
  }

  document.querySelectorAll('#feedbackType [data-type]').forEach((button) => {
    button.addEventListener('click', () => applyType(button.dataset.type));
  });

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.style.display = '';
  };
  const hideError = () => {
    errorEl.style.display = 'none';
  };

  submitBtn.addEventListener('click', async () => {
    const description = descEl.value.trim();
    if ([...description].length < 5) {
      showError(currentType === 'bug' ? '问题描述至少 5 个字' : '建议内容至少 5 个字');
      descEl.focus();
      return;
    }

    const body = { type: currentType, description, source: 'web' };
    if (currentType === 'bug') {
      const appVersion = appVersionEl.value.trim();
      if (!appVersion) {
        showError('启动器版本不能为空：在「设置 → 关于」里能看到');
        appVersionEl.focus();
        return;
      }
      body.app_version = appVersion;
      body.platform = platformEl.value;
      body.os_version = osVersionEl.value.trim();
      const steps = stepsEl.value.trim();
      if (!steps) {
        showError('复现步骤不能为空：按顺序写下你点过哪些地方');
        stepsEl.focus();
        return;
      }
      body.steps = steps;
      body.expected = expectedEl.value.trim();
      body.actual = actualEl.value.trim();
      body.logs = logsEl.value.trim();
      body.screenshots = screenshotsEl.value.trim();
    } else {
      body.scene = sceneEl.value.trim();
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '提交中…';
    hideError();
    try {
      await BB.api('/api/feedback', { method: 'POST', body });
      for (const el of [appVersionEl, osVersionEl, descEl, expectedEl, actualEl, logsEl, screenshotsEl, sceneEl]) {
        el.value = '';
      }
      stepsEl.value = '1. \n2. \n3. ';
      BB.toast('反馈已提交，感谢你的反馈！', 'ok');
      await loadMine(1);
      await loadAll(1);
    } catch (error) {
      showError(error.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '提交反馈';
    }
  });

  refreshBtn.addEventListener('click', () => {
    loadMine(Math.max(1, Number(BB.param('page') || 1) || 1));
    loadAll(1);
  });
});
