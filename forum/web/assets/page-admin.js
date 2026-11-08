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
  if (BB.state.me.role !== 'admin' && BB.state.me.role !== 'moderator') {
    host.innerHTML = `<div class="card composer">
      <h3>没有权限</h3>
      <p class="muted small">当前账号不是管理员，如需管理权限请联系站点负责人。</p>
    </div>`;
    return;
  }

  // 子页面由 HTML 上的 data-admin-section 决定；默认进统计首页
  const section = document.body.dataset.adminSection || 'home';

  // ------- 各子页面各自的数据，互不干扰 -------
  let overview = null; // /api/admin/overview：统计卡片 + 板块 + 最近主题
  let reports = null;
  let tagData = null;
  let userQuery = '';
  let adminUsers = [];
  let feedbackData = null;
  let feedbackStatus = 'open';
  let visitData = null;
  let visitDays = 30;
  let announcementData = null;
  let releaseData = null;

  // 客服工作台：会话列表 / 当前打开的玩家 / 已加载的消息
  let supportData = null;
  let supportPeer = null;
  let supportMessages = [];
  let supportHasMore = false;
  let supportSending = false;

  // 管理后台的子页面：页签在所有管理页顶部都能互相跳
  const ADMIN_TABS = [
    ['home', '统计', '/admin.html'],
    ['announcements', '公告', '/admin-announcements.html'],
    ['releases', '版本', '/admin-releases.html'],
    ['visits', '访问', '/admin-visits.html'],
    ['content', '内容', '/admin-content.html'],
    ['reports', '举报', '/admin-reports.html'],
    ['feedback', '反馈', '/admin-feedback.html'],
    ['support', '客服', '/admin-support.html'],
    ['users', '用户', '/admin-users.html'],
  ];

  function renderAdminTabs(active) {
    const tabs = document.getElementById('adminTabs');
    if (!tabs) return;
    tabs.innerHTML = ADMIN_TABS.map(
      ([key, label, href]) => `<a class="admin-tab${key === active ? ' active' : ''}" href="${href}">${label}</a>`,
    ).join('');
  }

  function statCard(value, label) {
    return `<div class="stat"><b>${BB.num(value)}</b><span>${label}</span></div>`;
  }

  // 下面几张对照表在各子页面里都要用，先声明再进入页面分发，免得撞上「用在了声明前」
  const PLATFORM_LABELS = {
    win64: 'Windows x64',
    winarm64: 'Windows ARM64',
    'linux-x64': 'Linux x64',
    'linux-arm64': 'Linux ARM64',
    'android-arm64-v8a': '安卓 arm64',
    'android-x86_64': '安卓 x86_64',
    'harmony-arm64-v8a': '鸿蒙',
    other: '其他',
  };

  const VISIT_RANGES = [
    [7, '近 7 天'],
    [30, '近 30 天'],
    [90, '近 90 天'],
  ];

  // 举报分类 slug → 中文（与客户端举报页、服务端白名单一致）
  const REPORT_CATEGORY_LABELS = {
    spam: '垃圾广告',
    insult: '人身攻击',
    porn: '色情低俗',
    illegal: '违法违规',
    infringe: '侵权盗搬',
    privacy: '泄露隐私',
    flooding: '引战/刷屏',
    other: '其他',
  };

  /** 禁言时长：0 表示永久，需要管理员手动解除 */
  const MUTE_HOURS = [
    [1, '1 小时'],
    [24, '24 小时'],
    [72, '3 天'],
    [168, '7 天'],
    [720, '30 天'],
    [0, '永久（手动解除）'],
  ];

  /** 管理员在后台能做的事：设人之前先摊开讲清楚，免得手滑把权限给错人 */
  const ADMIN_POWERS = [
    ['内容', '删除主题和回复、置顶或锁定主题、处理举报'],
    ['成员', '禁言（可分开发帖 / 回复 / 私信）、解除禁言、封禁账号'],
    ['权限', '给别的成员授予或取消管理员（不能改自己）'],
    ['板块标签', '新增、改名、排序、删除板块；推荐、合并、删除标签'],
    ['公告反馈', '发布或删除启动器首页公告；处理并回复用户反馈'],
    ['版本发布', '发布新版本、上传安装包、写更新日志、上线或下架版本'],
    ['访问数据', '浏览趋势、访客数、热门页面和全站统计'],
  ];

  try {
    renderAdminTabs(section);
    if (section === 'home') await bootHome();
    else if (section === 'announcements') await bootAnnouncements();
    else if (section === 'releases') await bootReleases();
    else if (section === 'visits') await bootVisits();
    else if (section === 'content') await bootContent();
    else if (section === 'reports') await bootReports();
    else if (section === 'feedback') await bootFeedback();
    else if (section === 'support') await bootSupport();
    else if (section === 'users') await bootUsers();
  } catch (error) {
    host.innerHTML = `<div class="card admin-section"><h2>加载失败</h2><p class="muted small">${BB.esc(
      error.message || '请刷新页面再试一次。',
    )}</p></div>`;
  }

  // ---------------- 统计首页 ----------------

  /** 首页只放统计数字和各子页面入口；带待处理数量的入口标红提醒 */
  async function bootHome() {
    const [data, reportData, feedbackResult, supportResult] = await Promise.all([
      BB.api('/api/admin/overview'),
      // 下面三项只为了拿「待处理」角标，接口出问题就不显示角标，不影响其余统计
      BB.api('/api/admin/reports?status=open').catch(() => null),
      BB.api('/api/admin/feedbacks?status=open&per_page=1').catch(() => null),
      BB.api('/api/admin/support/overview').catch(() => null),
    ]);
    overview = data;

    const stats = overview.stats;
    const hint = document.getElementById('adminHint');
    if (hint) hint.textContent = `数据库里共 ${stats.users} 位成员`;

    const reportBadge =
      reportData && reportData.counts && reportData.counts.open > 0 ? `待处理 ${reportData.counts.open}` : '';
    const feedbackBadge =
      feedbackResult && feedbackResult.counts && feedbackResult.counts.open > 0
        ? `待处理 ${feedbackResult.counts.open}`
        : '';
    const supportBadge = supportResult && supportResult.unread_total > 0 ? `待回复 ${supportResult.unread_total}` : '';

    const entries = [
      ['📢', '公告管理', '启动器首页公告与重要弹窗公告', '/admin-announcements.html', ''],
      ['🚀', '版本发布', '发新版本、传安装包、写更新日志', '/admin-releases.html', ''],
      ['📈', '访问数据', '浏览趋势、访客与热门页面', '/admin-visits.html', ''],
      ['🗃️', '内容管理', '板块、标签与最近主题', '/admin-content.html', ''],
      ['🚩', '举报审核', '处理玩家举报的帖子', '/admin-reports.html', reportBadge],
      ['📝', '反馈管理', '查看和回复用户反馈', '/admin-feedback.html', feedbackBadge],
      ['🎧', '客服消息', '回复玩家给官方客服的提问', '/admin-support.html', supportBadge],
      ['👥', '用户管理', '搜索用户、禁言、授予管理员', '/admin-users.html', ''],
    ];

    host.innerHTML = `
      <div class="admin-grid">
        ${statCard(stats.users, '成员')}
        ${statCard(stats.threads, '主题')}
        ${statCard(stats.posts, '回复')}
        ${statCard(stats.online, '15 分钟在线')}
      </div>
      <div class="admin-entry-grid">
        ${entries
          .map(
            ([icon, label, desc, href, badge]) => `
          <a class="card admin-entry" href="${href}">
            <span class="admin-entry-icon" aria-hidden="true">${icon}</span>
            <span class="admin-entry-text"><b>${label}</b><span class="small muted">${desc}</span></span>
            ${badge ? `<span class="chip chip-danger admin-entry-badge">${BB.esc(badge)}</span>` : ''}
          </a>`,
          )
          .join('')}
      </div>`;
  }

  // ---------------- 公告管理（首页公告 + 重要公告） ----------------

  async function bootAnnouncements() {
    announcementData = await BB.api('/api/admin/announcements');

    host.innerHTML = `
      <section class="card admin-section">
        <div class="visit-head">
          <h2>首页公告</h2>
          <span class="small muted" id="announceFileState" style="margin-left: auto"></span>
        </div>
        <div class="admin-form announce-form">
          <input class="input" id="announceText" maxlength="200" placeholder="公告内容（一行显示，建议 60 字以内）">
          <input class="input" id="announceLink" maxlength="500" placeholder="跳转链接（可选，https://… 或 /download.html）">
          <button class="btn btn-primary btn-sm" id="publishAnnounceBtn">一键发布</button>
        </div>
        <p class="small muted" style="margin: 8px 0 12px">
          发布后会写进官网 announcement.json，启动器首页公告栏最长约 10 分钟后显示；新的公告排在最前面。
        </p>
        <div id="announceError"></div>
        <div id="announceFileHint"></div>
        <table class="table">
          <thead><tr><th>公告</th><th>链接</th><th>发布时间</th><th>操作</th></tr></thead>
          <tbody id="announceRows"></tbody>
        </table>
      </section>

      <section class="card admin-section">
        <div class="visit-head">
          <h2>启动重要公告</h2>
          <span class="small muted" id="importantState" style="margin-left: auto"></span>
        </div>
        <p class="small muted" style="margin-bottom: 12px">
          发布后写进官网 announcement.json，启动器下次启动会弹窗显示；正文支持 Markdown（标题、列表、加粗、链接、引用等）。
          同一时间只弹一条，新发布的会自动顶替旧的；用户勾选「不再弹出这条公告」后，同一条不会再打扰。
        </p>
        <div class="important-form">
          <input class="input" id="importantTitle" maxlength="60" placeholder="标题（如：服务器维护通知）">
          <input class="input" id="importantLink" maxlength="500" placeholder="跳转链接（可选，https://… 或 /download.html）">
        </div>
        <div class="important-body">
          <textarea class="input textarea-lg" id="importantContent" maxlength="5000" placeholder="正文，支持 Markdown：&#10;## 小标题&#10;- 列表项&#10;**加粗**、&#96;代码&#96;、[链接](https://…)"></textarea>
        </div>
        <div class="important-actions">
          <button class="btn btn-primary btn-sm" id="publishImportantBtn">发布重要公告</button>
          <span class="small muted">发布后启动器下次启动就会弹窗，正文里的 Markdown 会排版显示。</span>
        </div>
        <div id="importantError"></div>
        <h3 class="important-history-title">历史记录</h3>
        <table class="table">
          <thead><tr><th>标题 / 正文</th><th>状态</th><th>发布时间</th><th>操作</th></tr></thead>
          <tbody id="importantRows"></tbody>
        </table>
      </section>`;

    renderAnnouncements();
    renderImportant();

    document.getElementById('publishAnnounceBtn').addEventListener('click', publishAnnouncement);
    document.getElementById('publishImportantBtn').addEventListener('click', publishImportant);

    // 重要公告正文用与发帖相同的 Markdown 编辑器：工具栏 + 编辑/预览，发布前先看效果
    const importantEditor = document.getElementById('importantContent');
    if (importantEditor) BB.attachMarkdownEditor(importantEditor, { presets: 'announcement' });

    for (const id of ['announceText', 'announceLink']) {
      document.getElementById(id).addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          publishAnnouncement();
        }
      });
    }
    for (const id of ['importantTitle', 'importantLink']) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          publishImportant();
        }
      });
    }
  }

  function renderAnnouncements() {
    const stateHost = document.getElementById('announceFileState');
    const hintHost = document.getElementById('announceFileHint');
    const body = document.getElementById('announceRows');
    if (!stateHost || !hintHost || !body) return;

    const file = (announcementData && announcementData.file) || {};
    const list = (announcementData && announcementData.announcements) || [];
    const writable = !!file.writable;

    stateHost.innerHTML = writable
      ? `<span class="chip chip-grey">公告文件可写</span> <span class="mono small" style="overflow-wrap:anywhere">${BB.esc(file.path || '')}</span>`
      : `<span class="chip chip-danger">公告文件不可写</span> <span class="mono small" style="overflow-wrap:anywhere">${BB.esc(file.path || '')}</span>`;

    const fileHint = file.exists
      ? `论坛服务没有写 ${BB.esc(file.path || '公告文件')} 的权限：把它交给论坛服务用户，并允许服务写这个目录后再发布。`
      : `公告文件 ${BB.esc(file.path || 'announcement.json')} 不存在：检查论坛 .env 里的 ANNOUNCEMENT_FILE 是否指向官网根目录。`;
    hintHost.innerHTML = writable ? '' : `<div class="form-error" style="margin: 8px 0 12px; overflow-wrap:anywhere">${fileHint}</div>`;

    if (!list.length) {
      body.innerHTML = '<tr><td colspan="4" class="muted">还没有公告。发布一条，启动器首页就会出现。</td></tr>';
      return;
    }

    body.innerHTML = list
      .map((item) => {
        // 站内相对路径在论坛域名下点不开，只作为文字展示；完整 http(s) 地址可以点
        const linkHtml = !item.link
          ? '<span class="muted">—</span>'
          : /^https?:/i.test(item.link)
            ? `<a href="${BB.esc(item.link)}" target="_blank" rel="noopener">${BB.esc(item.link)}</a>`
            : `<span class="mono small">${BB.esc(item.link)}</span> <span class="chip chip-grey">站内</span>`;
        return `
      <tr>
        <td>${BB.esc(item.text)}${item.enabled ? '' : ' <span class="chip chip-grey">已下线</span>'}</td>
        <td class="small">${linkHtml}</td>
        <td class="small nowrap">${BB.time(item.created_at)}</td>
        <td class="row-actions">
          <button class="btn btn-danger btn-sm" data-announce="${item.id}">删除</button>
        </td>
      </tr>`;
      })
      .join('');

    body.querySelectorAll('[data-announce]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!confirm('删除这条公告？启动器首页会跟着消失。')) return;
        button.disabled = true;
        try {
          await BB.api(`/api/admin/announcements/${button.dataset.announce}`, { method: 'DELETE' });
          announcementData = await BB.api('/api/admin/announcements');
          renderAnnouncements();
          BB.toast('公告已删除', 'ok');
        } catch (error) {
          button.disabled = false;
          BB.toast(error.message, 'error');
        }
      });
    });
  }

  async function publishAnnouncement() {
    const textInput = document.getElementById('announceText');
    const linkInput = document.getElementById('announceLink');
    const errorHost = document.getElementById('announceError');
    const button = document.getElementById('publishAnnounceBtn');
    const text = textInput.value.trim();
    if (!text) {
      BB.showError(errorHost, '先写公告内容');
      textInput.focus();
      return;
    }

    button.disabled = true;
    BB.showError(errorHost, '');
    try {
      await BB.api('/api/admin/announcements', {
        method: 'POST',
        body: { text, link: linkInput.value.trim() },
      });
      textInput.value = '';
      linkInput.value = '';
      announcementData = await BB.api('/api/admin/announcements');
      renderAnnouncements();
      BB.toast('公告已发布，启动器首页最长约 10 分钟后显示', 'ok');
    } catch (error) {
      BB.showError(errorHost, error.message);
    } finally {
      button.disabled = false;
    }
  }

  function renderImportant() {
    const stateHost = document.getElementById('importantState');
    const body = document.getElementById('importantRows');
    if (!stateHost || !body) return;

    const file = (announcementData && announcementData.file) || {};
    const list = (announcementData && announcementData.important) || [];
    const active = list.find((item) => item.enabled);

    stateHost.innerHTML = active
      ? `<span class="chip">正在弹窗：${BB.esc(active.title || '重要公告')}</span>`
      : '<span class="chip chip-grey">当前没有生效的重要公告</span>';

    if (!file.writable) {
      body.innerHTML =
        '<tr><td colspan="4" class="muted">公告文件不可写，发布前先按上面的提示修好文件权限。</td></tr>';
      return;
    }
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="4" class="muted">还没有重要公告。发布一条，启动器下次启动时会弹窗显示。</td></tr>';
      return;
    }

    body.innerHTML = list
      .map((item) => {
        const linkHtml = item.link
          ? `<div class="small muted" style="margin-top: 4px; overflow-wrap:anywhere">链接：${BB.esc(item.link)}</div>`
          : '';
        return `
      <tr>
        <td>
          <div class="important-title">${BB.esc(item.title || '重要公告')}
            ${item.enabled ? '' : '<span class="chip chip-grey">已下线</span>'}
          </div>
          <details class="important-more">
            <summary>查看正文</summary>
            <div class="post-content">${BB.md(item.content || '')}</div>
          </details>
          ${linkHtml}
        </td>
        <td class="small nowrap">${item.enabled ? '弹窗中' : '—'}</td>
        <td class="small nowrap">${BB.time(item.created_at)}</td>
        <td class="row-actions">
          <button class="btn ${item.enabled ? 'btn-ghost' : 'btn-primary'} btn-sm"
                  data-important-toggle="${item.id}" data-enabled="${item.enabled ? '0' : '1'}">
            ${item.enabled ? '下线' : '重新上线'}
          </button>
          <button class="btn btn-danger btn-sm" data-important-remove="${item.id}">删除</button>
        </td>
      </tr>`;
      })
      .join('');

    body.querySelectorAll('[data-important-toggle]').forEach((button) => {
      button.addEventListener('click', async () => {
        const enabled = button.dataset.enabled === '1';
        button.disabled = true;
        try {
          await BB.api(`/api/admin/important-announcements/${button.dataset.importantToggle}`, {
            method: 'PATCH',
            body: { enabled },
          });
          announcementData = await BB.api('/api/admin/announcements');
          renderAnnouncements();
          renderImportant();
          BB.toast(enabled ? '重要公告已上线，启动器下次启动会弹窗' : '已下线，启动器不再弹这条', 'ok');
        } catch (error) {
          button.disabled = false;
          BB.toast(error.message, 'error');
        }
      });
    });

    body.querySelectorAll('[data-important-remove]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!confirm('删除这条重要公告？如果它正在弹窗，启动器下次启动就不会再显示了。')) return;
        button.disabled = true;
        try {
          await BB.api(`/api/admin/important-announcements/${button.dataset.importantRemove}`, {
            method: 'DELETE',
          });
          announcementData = await BB.api('/api/admin/announcements');
          renderAnnouncements();
          renderImportant();
          BB.toast('重要公告已删除', 'ok');
        } catch (error) {
          button.disabled = false;
          BB.toast(error.message, 'error');
        }
      });
    });
  }

  async function publishImportant() {
    const titleInput = document.getElementById('importantTitle');
    const contentInput = document.getElementById('importantContent');
    const linkInput = document.getElementById('importantLink');
    const errorHost = document.getElementById('importantError');
    const button = document.getElementById('publishImportantBtn');
    if (!titleInput || !contentInput || !linkInput) return;

    const title = titleInput.value.trim();
    const content = contentInput.value.trim();
    const link = linkInput.value.trim();
    if (!title) {
      BB.showError(errorHost, '先给公告起个标题');
      titleInput.focus();
      return;
    }
    if (!content) {
      BB.showError(errorHost, '先写公告正文，支持 Markdown');
      contentInput.focus();
      return;
    }

    button.disabled = true;
    BB.showError(errorHost, '');
    try {
      await BB.api('/api/admin/important-announcements', {
        method: 'POST',
        body: { title, content, link },
      });
      titleInput.value = '';
      contentInput.value = '';
      linkInput.value = '';
      announcementData = await BB.api('/api/admin/announcements');
      renderAnnouncements();
      renderImportant();
      BB.toast('重要公告已发布，启动器下次启动会弹窗显示', 'ok');
    } catch (error) {
      BB.showError(errorHost, error.message);
    } finally {
      button.disabled = false;
    }
  }

  // ---------------- 版本发布 ----------------

  async function bootReleases() {
    // 版本数据单独容错：接口出问题时只是这块空着
    releaseData = await BB.api('/api/admin/releases').catch(() => null);

    host.innerHTML = `
      <section class="card admin-section">
        <div class="visit-head">
          <h2>版本发布</h2>
          <span class="small muted" id="releaseFileState" style="margin-left: auto"></span>
        </div>
        <p class="small muted" style="margin-bottom: 12px">
          发布后官网「一键下载」和启动器应用内更新马上用上新版本；安装包走官网 CDN 直链分发，浏览器下载前需过一次人机验证。
          先填版本号、更新日志和网盘链接点「发布」，再给这个版本上传各平台的安装包；同名文件重复上传会直接替换。
          官方源只保留<strong>最新两个正式版和两个测试版</strong>的安装包，更旧版本的文件会自动清理，
          版本号、更新日志和网盘链接则一直保留（老版本用户走网盘或 GitHub 下载）。
        </p>
        <div class="important-form">
          <input class="input" id="releaseVersion" maxlength="32" placeholder="版本号（如 beta8，与启动器内显示的保持一致）">
        </div>
        <div class="important-form" style="grid-template-columns: 1fr 1fr 1fr">
          <input class="input" id="releaseLink123" maxlength="500" placeholder="123 盘链接（可选，https://…，老版本文件清理后用户从这里下载）">
          <input class="input" id="releaseLinkQuark" maxlength="500" placeholder="夸克网盘链接（可选，https://…）">
          <input class="input" id="releaseLinkGithub" maxlength="500" placeholder="GitHub Release 链接（可选，https://github.com/…）">
        </div>
        <div class="important-body">
          <textarea class="input textarea-lg" id="releaseNotes" maxlength="8000" placeholder="更新日志，支持 Markdown：&#10;## 修复&#10;- 修了某某问题"></textarea>
        </div>
        <div class="important-actions">
          <button class="btn btn-primary btn-sm" id="publishReleaseBtn">发布 / 更新版本</button>
          <span class="small muted">同版本号再次发布只更新日志，不会重复建条目。</span>
        </div>
        <div id="releaseError"></div>
        <h3 class="important-history-title">已发布的版本</h3>
        <div id="releaseRows"></div>
      </section>`;

    renderReleases();

    document.getElementById('publishReleaseBtn').addEventListener('click', publishRelease);
    // 更新日志用与发帖相同的 Markdown 编辑器：工具栏 + 编辑/预览
    const releaseEditor = document.getElementById('releaseNotes');
    if (releaseEditor) BB.attachMarkdownEditor(releaseEditor, { presets: 'release' });
  }

  /** 从安装包文件名猜平台标记（与一键打包.bat 的命名约定一致），猜不出交给管理员手选 */
  function guessReleasePlatform(filename) {
    const name = String(filename || '').toLowerCase();
    if (name.includes('winarm64')) return 'winarm64';
    if (name.includes('win64')) return 'win64';
    if (name.includes('linux-arm64')) return 'linux-arm64';
    if (name.includes('linux-x64')) return 'linux-x64';
    if (name.includes('arm64-v8a')) return 'android-arm64-v8a';
    if (name.includes('x86_64')) return 'android-x86_64';
    if (name.includes('harmony')) return 'harmony-arm64-v8a';
    if (name.includes('android')) return 'android-arm64-v8a';
    if (name.includes('linux')) return 'linux-x64';
    return '';
  }

  function fileSizeText(bytes) {
    const value = Number(bytes || 0);
    if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }

  async function reloadReleases() {
    releaseData = await BB.api('/api/admin/releases');
    renderReleases();
  }

  function renderReleases() {
    const stateHost = document.getElementById('releaseFileState');
    const rows = document.getElementById('releaseRows');
    if (!stateHost || !rows) return;

    if (!releaseData) {
      rows.innerHTML = '<p class="muted small">版本数据加载失败，刷新页面再试一次。</p>';
      return;
    }

    const file = releaseData.file || {};
    stateHost.innerHTML = file.writable
      ? `<span class="chip chip-grey">版本文件可写</span> <span class="mono small" style="overflow-wrap:anywhere">${BB.esc(file.path || '')}</span>`
      : `<span class="chip chip-danger">版本文件不可写</span> <span class="mono small" style="overflow-wrap:anywhere">${BB.esc(file.path || '')}</span>`;
    if (!file.writable) {
      rows.innerHTML = `<div class="form-error" style="margin: 8px 0; overflow-wrap:anywhere">论坛服务写不了版本文件 ${BB.esc(file.path || 'latest.json')}：把它交给论坛服务用户后再发布。</div>`;
      return;
    }

    const list = releaseData.versions || [];
    if (!list.length) {
      rows.innerHTML = '<p class="muted small">还没有发布任何版本：先在上面填好版本号、更新日志和下载链接，点「发布 / 更新版本」；发布后这里会出现版本卡片，卡片里就是「上传安装包」的位置。</p>';
      return;
    }

    const maxBytes = (releaseData.upload && releaseData.upload.max_bytes) || 300 * 1024 * 1024;
    rows.innerHTML = list
      .map((item) => {
        const files = item.files || [];
        const fileRows = files.length
          ? files
              .map(
                (f) => `
            <div class="release-file" data-file="${f.id}">
              <span class="mono small">${BB.esc(f.filename)}</span>
              <span class="chip chip-grey">${BB.esc(PLATFORM_LABELS[f.platform] || f.platform)}</span>
              <span class="small muted">${fileSizeText(f.size)} · 下载 ${BB.num(f.downloads)} 次</span>
              <button class="btn btn-ghost btn-sm" data-act="delfile">删除</button>
            </div>`,
              )
              .join('')
          : item.within_retention
            ? '<p class="small muted" style="margin: 6px 0">还没有安装包，用下面的按钮上传（可一次多选）。</p>'
            : '<p class="small muted" style="margin: 6px 0">安装包已按保留策略自动清理（只留最新两个正式版和两个测试版）；用户从下面的网盘链接或 GitHub 下载这个版本。</p>';
        const links = [
          ['123 盘', item.link_123pan],
          ['夸克网盘', item.link_quark],
          ['GitHub', item.link_github],
        ]
          .filter(([, link]) => link)
          .map(
            ([label, link]) =>
              `<a class="btn btn-ghost btn-sm" href="${BB.esc(link)}" target="_blank" rel="noopener" title="${BB.esc(link)}">${label}</a>`,
          )
          .join('');
        const uploadDisabled = !item.within_retention;
        const platformOptions = Object.entries(PLATFORM_LABELS)
          .map(([key, label]) => `<option value="${key}">${label}</option>`)
          .join('');
        return `
      <div class="card release-card${item.within_retention ? '' : ' release-card-pruned'}" data-version="${item.id}" data-enabled="${item.enabled ? 1 : 0}">
        <div class="release-head">
          <b>${BB.esc(item.version)}</b>
          ${item.enabled ? '<span class="chip">现行版本</span>' : '<span class="chip chip-grey">已下架</span>'}
          ${item.within_retention ? '' : '<span class="chip chip-warn" title="官方源只保留最新两个正式版和两个测试版的安装包">文件已清理</span>'}
          <span class="small muted">${BB.time(item.created_at)} · ${BB.esc(item.created_by || '—')}</span>
          <span class="row-actions" style="margin-left:auto">
            <button class="btn btn-ghost btn-sm" data-act="toggle">${item.enabled ? '下架' : '上线'}</button>
            <button class="btn btn-danger btn-sm" data-act="del">删除</button>
          </span>
        </div>
        ${item.notes ? `<pre class="release-notes">${BB.esc(item.notes.length > 200 ? `${item.notes.slice(0, 200)}…` : item.notes)}</pre>` : ''}
        ${links ? `<div class="release-links">${links}</div>` : ''}
        <div class="release-files">${fileRows}</div>
        <div class="admin-form" style="grid-template-columns: 2fr auto auto">
          <input class="input" type="file" multiple data-act="pick"${uploadDisabled ? ' disabled' : ''}>
          <select class="input" data-act="platform"${uploadDisabled ? ' disabled' : ''}>
            <option value="">平台（按文件名识别）</option>
            ${platformOptions}
          </select>
          <button class="btn btn-primary btn-sm" data-act="upload"${uploadDisabled ? ' disabled title="这个版本的文件组已按保留策略清理，不能再上传；把安装包传网盘后把链接填进发布表单"' : ''}>上传安装包</button>
        </div>
        <div class="small muted" data-act="progress" style="margin-top: 6px; min-height: 1em"></div>
        <p class="small muted" style="margin: 4px 0 0">单个文件上限 ${fileSizeText(maxBytes)}；再大的包请传网盘或 GitHub，把链接填进上面的发布表单。</p>
      </div>`;
      })
      .join('');

    rows.querySelectorAll('.release-card').forEach((card) => {
      const versionId = card.dataset.version;
      const enabled = card.dataset.enabled === '1';

      card.querySelector('[data-act="toggle"]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await BB.api(`/api/admin/releases/${versionId}`, { method: 'PATCH', body: { enabled: !enabled } });
          await reloadReleases();
          BB.toast(enabled ? '版本已下架：官网一键下载与启动器更新不再下发它' : '版本已上线：官网与启动器更新马上生效', 'ok');
        } catch (error) {
          button.disabled = false;
          BB.toast(error.message, 'error');
        }
      });

      card.querySelector('[data-act="del"]').addEventListener('click', async (event) => {
        if (!confirm('删除这个版本？安装包文件会一起从服务器删掉。')) return;
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await BB.api(`/api/admin/releases/${versionId}`, { method: 'DELETE' });
          await reloadReleases();
          BB.toast('版本已删除', 'ok');
        } catch (error) {
          button.disabled = false;
          BB.toast(error.message, 'error');
        }
      });

      card.querySelector('[data-act="upload"]').addEventListener('click', async () => {
        const picker = card.querySelector('[data-act="pick"]');
        const select = card.querySelector('[data-act="platform"]');
        const progress = card.querySelector('[data-act="progress"]');
        const files = Array.from((picker && picker.files) || []);
        if (!files.length) {
          progress.textContent = '先在左边选择要上传的安装包文件';
          return;
        }
        for (const file of files) {
          const platform = select.value || guessReleasePlatform(file.name) || 'other';
          try {
            await uploadReleaseFile(versionId, file, platform, progress);
          } catch (error) {
            progress.textContent = '';
            BB.toast(`${file.name}：${error.message}`, 'error');
            return;
          }
        }
        if (picker) picker.value = '';
        await reloadReleases();
        BB.toast('安装包上传完成，官网直链已更新', 'ok');
      });

      card.querySelectorAll('.release-file [data-act="delfile"]').forEach((button) => {
        button.addEventListener('click', async () => {
          const fileId = button.closest('[data-file]').dataset.file;
          if (!confirm('删除这个安装包文件？')) return;
          button.disabled = true;
          try {
            await BB.api(`/api/admin/releases/${versionId}/files/${fileId}`, { method: 'DELETE' });
            await reloadReleases();
            BB.toast('文件已删除', 'ok');
          } catch (error) {
            button.disabled = false;
            BB.toast(error.message, 'error');
          }
        });
      });
    });
  }

  /** 用 XHR 上传（fetch 拿不到上传进度）：原始字节直传，文件名与平台走查询串 */
  function uploadReleaseFile(versionId, file, platform, progressHost) {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({ platform, filename: file.name });
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/admin/releases/${versionId}/files?${params}`);
      xhr.setRequestHeader('accept', 'application/json');
      xhr.upload.onprogress = (event) => {
        if (progressHost && event.lengthComputable) {
          progressHost.textContent = `正在上传 ${file.name}：${Math.round((event.loaded / event.total) * 100)}%`;
        }
      };
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* 非 JSON 响应按错误处理 */
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          if (progressHost) progressHost.textContent = `${file.name} 上传完成`;
          resolve(data);
        } else {
          reject(new Error((data && data.error) || `上传失败（${xhr.status}）`));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误，上传失败'));
      xhr.send(file);
    });
  }

  async function publishRelease() {
    const versionInput = document.getElementById('releaseVersion');
    const link123Input = document.getElementById('releaseLink123');
    const linkQuarkInput = document.getElementById('releaseLinkQuark');
    const linkGithubInput = document.getElementById('releaseLinkGithub');
    const notesInput = document.getElementById('releaseNotes');
    const errorHost = document.getElementById('releaseError');
    const button = document.getElementById('publishReleaseBtn');
    const version = versionInput.value.trim();
    if (!version) {
      BB.showError(errorHost, '先填版本号，比如 beta8');
      versionInput.focus();
      return;
    }

    button.disabled = true;
    BB.showError(errorHost, '');
    try {
      const result = await BB.api('/api/admin/releases', {
        method: 'POST',
        body: {
          version,
          notes: notesInput.value,
          link_123pan: link123Input.value.trim(),
          link_quark: linkQuarkInput.value.trim(),
          link_github: linkGithubInput.value.trim(),
        },
      });
      versionInput.value = '';
      link123Input.value = '';
      linkQuarkInput.value = '';
      linkGithubInput.value = '';
      notesInput.value = '';
      await reloadReleases();
      BB.toast(`版本 ${result.release.tag_name} 已发布，官网一键下载与启动器更新通道已生效`, 'ok');
    } catch (error) {
      BB.showError(errorHost, error.message);
    } finally {
      button.disabled = false;
    }
  }

  // ---------------- 访问数据 ----------------

  async function bootVisits() {
    // 访问数据单独容错：接口出问题时只是这块空着
    visitData = await BB.api(`/api/admin/visits?days=${visitDays}`).catch(() => null);

    host.innerHTML = `
      <section class="card admin-section">
        <div class="visit-head">
          <h2>访问数据</h2>
          <div class="visit-range" id="visitRange"></div>
        </div>
        <div class="visit-stats" id="visitStats"></div>
        <p class="small muted visit-note" id="visitNote"></p>
        <div class="visit-chart-box">
          <div class="visit-chart-head">
            <b>浏览趋势</b>
            <span class="visit-legend"><i class="visit-dot visit-dot-uv"></i>访客 <i class="visit-dot visit-dot-pv"></i>浏览</span>
          </div>
          <div class="visit-chart" id="visitChart"></div>
          <div class="visit-axis" id="visitAxis"></div>
        </div>
        <div class="visit-chart-head" style="margin-top: 18px"><b>今日 24 小时</b></div>
        <div class="visit-hours" id="visitHours"></div>
        <div class="visit-chart-head" style="margin-top: 18px"><b>访问最多的页面</b></div>
        <div id="visitPages"></div>
      </section>`;

    renderVisits();
  }

  /** 较昨日涨跌：昨天没有数据时不显示百分比，免得出现 +∞ */
  function visitDelta(value, base) {
    if (!base) return '';
    const pct = Math.round(((value - base) / base) * 100);
    return pct ? `较昨日 ${pct > 0 ? '+' : ''}${pct}%` : '与昨日持平';
  }

  function visitStatCard(value, label, note = '') {
    return `<div class="visit-stat"><b>${value}</b><span>${label}</span>${note ? `<em>${note}</em>` : ''}</div>`;
  }

  function renderVisits() {
    if (!visitData) {
      const note = document.getElementById('visitNote');
      if (note) note.textContent = '访问数据加载失败，刷新页面再试一次。';
      return;
    }
    const stats = visitData.summary;
    const series = visitData.series || [];
    const hours = visitData.hours || [];
    const pages = visitData.pages || [];
    const empty = !stats.total.pv;

    // 天数切换：7 / 30 / 90
    const range = document.getElementById('visitRange');
    range.innerHTML = VISIT_RANGES.map(
      ([days, label]) =>
        `<button class="btn btn-sm ${days === visitDays ? 'btn-primary' : 'btn-ghost'}" data-vdays="${days}">${label}</button>`,
    ).join('');
    range.querySelectorAll('[data-vdays]').forEach((button) => {
      button.addEventListener('click', async () => {
        const days = Number(button.dataset.vdays);
        if (days === visitDays) return;
        button.disabled = true;
        try {
          visitData = await BB.api(`/api/admin/visits?days=${days}`);
          visitDays = days;
          renderVisits();
        } catch (error) {
          button.disabled = false;
          BB.toast(error.message, 'error');
        }
      });
    });

    document.getElementById('visitNote').textContent = empty
      ? '还没有访问记录：有人打开论坛任意页面后就会自动开始统计。'
      : `只统计真实打开的页面，接口请求、图片、管理后台和搜索引擎爬虫都不算；访问明细保留 ${visitData.retention_days} 天。`;

    const peakNote = stats.peak ? `单日最高 ${BB.num(stats.peak.pv)}（${stats.peak.day.slice(5).replace('-', '/')}）` : '';
    document.getElementById('visitStats').innerHTML = [
      visitStatCard(BB.num(stats.today.pv), '今日浏览', visitDelta(stats.today.pv, stats.yesterday.pv)),
      visitStatCard(BB.num(stats.today.uv), '今日访客（日活）', `首次到访 ${BB.num(stats.today.new_visitors)}`),
      visitStatCard(BB.num(stats.week.uv), '近 7 天访客', `浏览 ${BB.num(stats.week.pv)}`),
      visitStatCard(BB.num(stats.month.uv), '近 30 天活跃（月活）', `浏览 ${BB.num(stats.month.pv)}`),
      visitStatCard(BB.num(stats.total.pv), '累计浏览', peakNote),
      visitStatCard(
        BB.num(stats.total.uv),
        '累计访客',
        stats.total.last_seen_at ? `最近 ${BB.time(stats.total.last_seen_at)}` : '',
      ),
    ].join('');

    // 趋势：每天的浏览（浅色柱）里有多少是访客（深色柱），同一根柱子里能直接看出比例
    const maxPv = Math.max(1, ...series.map((item) => item.pv));
    document.getElementById('visitChart').innerHTML = series
      .map((item) => {
        const pvHeight = item.pv ? Math.max(2, Math.round((item.pv / maxPv) * 100)) : 0;
        const uvHeight = item.uv ? Math.max(2, Math.round((item.uv / maxPv) * 100)) : 0;
        return `<div class="visit-bar-col" title="${item.day} · 浏览 ${item.pv} · 访客 ${item.uv}">
          <div class="visit-bar-track">
            <i class="visit-bar-pv" style="height: ${pvHeight}%"></i>
            <i class="visit-bar-uv" style="height: ${uvHeight}%"></i>
          </div>
        </div>`;
      })
      .join('');

    const labels = [series[0], series[Math.floor((series.length - 1) / 2)], series[series.length - 1]].filter(Boolean);
    document.getElementById('visitAxis').innerHTML = labels
      .map((item) => `<span>${item.day.slice(5).replace('-', '/')}</span>`)
      .join('');

    // 今日 24 小时：每 6 小时标一个刻度
    const maxHourPv = Math.max(1, ...hours.map((item) => item.pv));
    document.getElementById('visitHours').innerHTML = hours
      .map((item) => {
        const height = item.pv ? Math.max(2, Math.round((item.pv / maxHourPv) * 100)) : 0;
        return `<div class="visit-hour" title="${item.hour}:00 – ${item.hour + 1}:00 · 浏览 ${item.pv} · 访客 ${item.uv}">
          <div class="visit-hour-track"><i style="height: ${height}%"></i></div>
          <em>${item.hour % 6 === 0 ? item.hour : ''}</em>
        </div>`;
      })
      .join('');

    const pagesHost = document.getElementById('visitPages');
    if (!pages.length) {
      pagesHost.innerHTML = '<div class="empty">这段时间还没有访问记录。</div>';
      return;
    }
    const maxPagePv = Math.max(1, ...pages.map((item) => item.pv));
    pagesHost.innerHTML = `<table class="table">
      <thead><tr><th>页面</th><th>浏览</th><th>访客</th><th>占比</th></tr></thead>
      <tbody>${pages
        .map(
          (item) => `<tr>
            <td>${BB.esc(item.label)}<div class="small muted mono">${BB.esc(item.path)}</div></td>
            <td class="small">${BB.num(item.pv)}</td>
            <td class="small">${BB.num(item.uv)}</td>
            <td class="small"><span class="visit-share"><i style="width: ${Math.round((item.pv / maxPagePv) * 100)}%"></i></span></td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>`;
  }

  // ---------------- 内容管理（板块 + 标签 + 最近主题） ----------------

  async function bootContent() {
    const [data, tagResult] = await Promise.all([BB.api('/api/admin/overview'), BB.api('/api/admin/tags')]);
    overview = data;
    tagData = tagResult;

    const hint = document.getElementById('adminHint');
    if (hint) hint.textContent = `数据库里共 ${overview.stats.users} 位成员`;

    host.innerHTML = `
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
        <h2>最近主题</h2>
        <table class="table">
          <thead><tr><th>标题</th><th>板块</th><th>作者</th><th>时间</th><th>操作</th></tr></thead>
          <tbody id="threadRows"></tbody>
        </table>
      </section>`;

    renderBoards();
    renderThreads();
    renderTags();

    document.getElementById('addBoardBtn').addEventListener('click', addBoard);
    document.getElementById('mergeBtn').addEventListener('click', mergeTags);
  }

  /** 板块 / 标签 / 最近主题有变动后一起刷新这三块 */
  async function refreshContent() {
    const [data, tagResult] = await Promise.all([BB.api('/api/admin/overview'), BB.api('/api/admin/tags')]);
    overview = data;
    tagData = tagResult;
    renderBoards();
    renderThreads();
    renderTags();
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
          refreshContent();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
      row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
        if (!confirm('确定删除这个板块？板块里有主题时不能删。')) return;
        try {
          await BB.api(`/api/admin/boards/${boardId}`, { method: 'DELETE' });
          BB.toast('板块已删除', 'ok');
          refreshContent();
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
      refreshContent();
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
          refreshContent();
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
          refreshContent();
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
      refreshContent();
    } catch (error) {
      BB.showError(errorHost, error.message);
    }
  }

  // ---------------- 举报审核 ----------------

  async function bootReports() {
    reports = await BB.api('/api/admin/reports?status=open');

    host.innerHTML = `
      <section class="card admin-section">
        <h2>审核队列 ${reports.counts.open > 0 ? `<span class="chip chip-danger">待处理 ${reports.counts.open}</span>` : '<span class="chip chip-grey">没有待处理的举报</span>'}</h2>
        <table class="table">
          <thead><tr><th>楼层</th><th>所属主题</th><th>作者</th><th>举报人</th><th>理由</th><th>时间</th><th>操作</th></tr></thead>
          <tbody id="reportRows"></tbody>
        </table>
        <div id="reportError"></div>
      </section>`;

    renderReports();
  }

  /** 处理完一条举报后重新拉队列 */
  async function refreshReports() {
    reports = await BB.api('/api/admin/reports?status=open');
    const head = host.querySelector('.admin-section h2');
    if (head) {
      head.innerHTML = `审核队列 ${
        reports.counts.open > 0
          ? `<span class="chip chip-danger">待处理 ${reports.counts.open}</span>`
          : '<span class="chip chip-grey">没有待处理的举报</span>'
      }`;
    }
    renderReports();
  }

  function renderReports() {
    const body = document.getElementById('reportRows');
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
        <td class="small">${
          REPORT_CATEGORY_LABELS[report.category]
            ? `<span class="chip chip-grey">${REPORT_CATEGORY_LABELS[report.category]}</span> `
            : ''
        }${BB.esc(report.reason || '未填写')}</td>
        <td class="small nowrap">${BB.time(report.created_at)}</td>
        <td class="row-actions">
          <a class="btn btn-ghost btn-sm" href="/thread.html?id=${report.thread_id}#post-${report.post_id}">查看</a>
          <button class="btn btn-danger btn-sm" data-report="${report.id}" data-act="delete">删帖并处理</button>
          <button class="btn btn-ghost btn-sm" data-report="${report.id}" data-act="ignore">忽略</button>
          ${
            report.reporter
              ? `<button class="btn btn-ghost btn-sm" data-reporter="${report.reporter.id}" data-username="${BB.esc(
                  report.reporter.username,
                )}">回复举报人</button>`
              : ''
          }
        </td>
      </tr>`,
      )
      .join('');

    body.querySelectorAll('[data-reporter]').forEach((button) => {
      button.addEventListener('click', () => {
        openNotifyDialog(
          { id: Number(button.dataset.reporter), username: button.dataset.username || '' },
          { title: '关于您举报的处理说明', context: '就这条举报向举报人说明处理情况。' },
        );
      });
    });

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
          refreshReports();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    });
  }

  // ---------------- 反馈管理 ----------------

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

  async function bootFeedback() {
    feedbackData = await BB.api(`/api/admin/feedbacks?status=${feedbackStatus}&per_page=50`);

    host.innerHTML = `
      <section class="card admin-section">
        <h2>反馈管理 <span id="feedbackPendingChip"></span></h2>
        <div id="feedbackFilters" style="display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap"></div>
        <div id="feedbackRows"></div>
      </section>`;

    renderFeedback();
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
          <input class="input" placeholder="回复（将以系统通知发给用户，可选）" data-reply="${item.id}">
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

  // ---------------- 客服消息 ----------------

  async function bootSupport() {
    // 客服消息单独容错：老服务端没有这个接口时给出提示，不影响别的页面
    supportData = await BB.api('/api/admin/support/overview').catch(() => null);

    host.innerHTML = `
      <section class="card admin-section">
        <div class="visit-head">
          <h2>客服消息 <span id="supportUnreadChip"></span></h2>
          <span class="small muted" style="margin-left: auto">以「方块盒子官方客服」身份回复</span>
        </div>
        <p class="small muted" style="margin-bottom: 12px">
          玩家在聊天页给官方客服发来的问题都会出现在这里，点开一位玩家就能直接回复；
          回复会立刻送进 TA 的聊天窗口，不用去动别的账号。有新提问时，这里每几秒自动刷新一次。
        </p>
        <div class="support-shell">
          <div class="support-list" id="supportList"></div>
          <div class="support-chat">
            <div class="support-chat-head" id="supportChatHead"></div>
            <div class="support-chat-body" id="supportChatBody"></div>
            <form class="support-composer" id="supportForm">
              <textarea class="textarea" id="supportInput" maxlength="1000" rows="2"
                        placeholder="写回复…（Enter 发送，Shift+Enter 换行）"></textarea>
              <button class="btn btn-primary btn-sm" id="supportSendBtn" type="submit">发送</button>
            </form>
          </div>
        </div>
      </section>`;

    renderSupport();

    // 列表点击 / 发送框只在进入页面时绑定一次，轮询只更新内容
    document.getElementById('supportList').addEventListener('click', (event) => {
      const row = event.target.closest('[data-support-user]');
      if (row) openSupportChat(Number(row.dataset.supportUser));
    });
    document.getElementById('supportForm').addEventListener('submit', (event) => {
      event.preventDefault();
      sendSupportReply();
    });
    document.getElementById('supportInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendSupportReply();
      }
    });

    // 后台开着时每 6 秒同步一次新提问和当前会话；正打开着就算已读
    setInterval(pollSupport, 6000);
  }

  function supportConversationPreview(item) {
    const last = item.last_message;
    if (!last) return '还没有聊过';
    const text = last.kind === 'withdrawn' ? '撤回了一条消息' : last.kind === 'image' ? '[图片]' : last.body || '';
    return `${last.mine ? '客服：' : ''}${text}`;
  }

  function supportMessageHtml(msg) {
    if (msg.kind === 'withdrawn') {
      return `<div class="msg-withdrawn">${msg.mine ? '客服撤回了一条消息' : '玩家撤回了一条消息'}</div>`;
    }
    let inner;
    if (msg.kind === 'image' && msg.image) {
      const url = BB.esc(BB.media(msg.image));
      inner =
        `<a class="img-link" href="${url}" data-full="${url}" target="_blank" rel="noopener">` +
        `<img class="msg-image" src="${url}" alt="图片" loading="lazy"></a>` +
        (msg.body ? `<div class="msg-text">${BB.esc(msg.body)}</div>` : '');
    } else {
      inner = `<div class="msg-text">${BB.esc(msg.body || '')}</div>`;
    }
    const time = `<span class="msg-time">${BB.datetime(msg.created_at)}</span>`;
    return `<div class="msg-row ${msg.mine ? 'mine' : 'theirs'}">
      ${msg.mine ? '' : BB.avatar(supportPeer, 'avatar-xs')}
      <div class="msg-body"><div class="msg-bubble">${inner}</div>${time}</div>
    </div>`;
  }

  /** 只重画会话列表 / 聊天区；输入框与事件监听不重建 */
  function renderSupport() {
    const list = document.getElementById('supportList');
    const head = document.getElementById('supportChatHead');
    const body = document.getElementById('supportChatBody');
    const chip = document.getElementById('supportUnreadChip');
    if (!list || !head || !body || !chip) return;

    if (!supportData) {
      chip.innerHTML = '<span class="chip chip-danger">客服接口未响应</span>';
      list.innerHTML = '<div class="empty">客服接口没有响应，刷新页面再试试。</div>';
      head.innerHTML = '<div class="support-head-empty">选择左侧的玩家，查看提问并回复</div>';
      body.innerHTML = '<div class="empty">玩家的消息会出现在这里</div>';
      return;
    }

    chip.innerHTML =
      supportData.unread_total > 0
        ? `<span class="chip chip-danger">待回复 ${supportData.unread_total}</span>`
        : '<span class="chip chip-grey">没有待回复的消息</span>';

    const conversations = supportData.conversations || [];
    list.innerHTML = conversations.length
      ? conversations
          .map((item) => {
            const name = item.user.display_name || item.user.username;
            return `<div class="support-row${supportPeer && supportPeer.id === item.user.id ? ' active' : ''}"
                         data-support-user="${item.user.id}">
              ${BB.avatar(item.user, 'avatar-sm')}
              <div class="support-row-main">
                <div class="support-row-top">
                  <span class="fr-name">${BB.esc(name)}</span>
                  ${item.unread ? `<span class="fr-badge">${item.unread > 99 ? '99+' : item.unread}</span>` : ''}
                  <span class="fr-time">${item.last_message ? BB.time(item.last_message.created_at) : ''}</span>
                </div>
                <div class="fr-preview">${BB.esc(supportConversationPreview(item))}</div>
              </div>
            </div>`;
          })
          .join('')
      : '<div class="empty">还没有玩家提问。玩家在聊天页给官方客服发消息后会显示在这里。</div>';

    if (!supportPeer) {
      head.innerHTML = '<div class="support-head-empty">选择左侧的玩家，查看提问并回复</div>';
      body.innerHTML = '<div class="empty">玩家的消息会出现在这里</div>';
      return;
    }

    const name = supportPeer.display_name || supportPeer.username || `玩家 #${supportPeer.id}`;
    const status = supportPeer.online
      ? '在线'
      : supportPeer.last_seen_at
        ? `最近活跃 ${BB.time(supportPeer.last_seen_at)}`
        : '离线';
    head.innerHTML = `
      ${BB.avatar(supportPeer, 'avatar-sm')}
      <div class="support-head-text">
        <div class="chat-head-name">${BB.esc(name)}</div>
        <div class="chat-head-status">${status} · <a href="/user.html?id=${supportPeer.id}" target="_blank" rel="noopener">查看主页</a></div>
      </div>`;
    body.innerHTML = supportMessages.length
      ? `${supportHasMore ? '<div class="small muted" style="text-align:center">只显示最近 60 条消息</div>' : ''}${supportMessages
          .map(supportMessageHtml)
          .join('')}`
      : '<div class="empty">这位玩家还没有发过消息</div>';
  }

  function scrollSupportBottom() {
    const body = document.getElementById('supportChatBody');
    if (body) body.scrollTop = body.scrollHeight;
  }

  async function openSupportChat(userId) {
    if (!userId) return;
    const item = (supportData?.conversations || []).find((entry) => entry.user.id === userId);
    supportPeer = item
      ? { ...item.user }
      : supportPeer && supportPeer.id === userId
        ? supportPeer
        : { id: userId, username: '', display_name: `玩家 #${userId}`, avatar: '', last_seen_at: 0 };
    supportMessages = [];
    supportHasMore = false;
    renderSupport();
    const body = document.getElementById('supportChatBody');
    if (body) body.innerHTML = '<div class="empty">正在加载消息…</div>';

    try {
      const data = await BB.api(`/api/admin/support/conversations/${userId}`);
      supportPeer = { ...supportPeer, ...data.user };
      supportMessages = data.messages || [];
      supportHasMore = !!data.has_more;
      // 本地把这位玩家的未读清掉，不用等下一轮轮询
      if (item) {
        supportData.unread_total = Math.max(0, Number(supportData.unread_total || 0) - Number(item.unread || 0));
        item.unread = 0;
      }
      renderSupport();
      scrollSupportBottom();
      document.getElementById('supportInput')?.focus();
    } catch (error) {
      const host = document.getElementById('supportChatBody');
      if (host) host.innerHTML = `<div class="empty">${BB.esc(error.message || '加载失败')}</div>`;
    }
  }

  async function sendSupportReply() {
    const input = document.getElementById('supportInput');
    const button = document.getElementById('supportSendBtn');
    if (!input || !button || !supportPeer || supportSending) return;
    const content = input.value.trim();
    if (!content) return;

    supportSending = true;
    button.disabled = true;
    try {
      const data = await BB.api(`/api/admin/support/conversations/${supportPeer.id}`, {
        method: 'POST',
        body: { body: content },
      });
      input.value = '';
      supportMessages.push(data.message);
      renderSupport();
      scrollSupportBottom();
      input.focus();
      // 会话列表里的「最后一条」和排序跟着更新；刷新失败也不影响已发出的回复
      try {
        supportData = await BB.api('/api/admin/support/overview');
        renderSupport();
        scrollSupportBottom();
      } catch {
        /* ignore */
      }
    } catch (error) {
      BB.toast(error.message || '发送失败，稍后再试', 'error');
    } finally {
      supportSending = false;
      button.disabled = false;
    }
  }

  async function pollSupport() {
    if (document.hidden || !document.getElementById('supportList')) return;
    try {
      supportData = await BB.api('/api/admin/support/overview');
      if (supportPeer) {
        const data = await BB.api(`/api/admin/support/conversations/${supportPeer.id}?limit=60`);
        supportPeer = { ...supportPeer, ...data.user };
        supportMessages = data.messages || [];
        supportHasMore = !!data.has_more;
        const item = (supportData.conversations || []).find((entry) => entry.user.id === supportPeer.id);
        if (item) item.unread = 0;
      }
      renderSupport();
      const body = document.getElementById('supportChatBody');
      if (body && body.scrollHeight - body.scrollTop - body.clientHeight < 80) scrollSupportBottom();
    } catch {
      /* 网络抖动忽略，等下一轮 */
    }
  }

  // ---------------- 用户管理 ----------------

  async function bootUsers() {
    host.innerHTML = `
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

    await renderUsers();

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

  /** 已禁言的用户打开弹窗时，默认选中和剩余时间最接近的一档 */
  function guessHours(user) {
    if (user.status !== 'muted') return 24;
    if (!user.muted_until) return 0;
    const left = (Number(user.muted_until) * 1000 - Date.now()) / 3600000;
    let best = 24;
    MUTE_HOURS.forEach(([hours]) => {
      if (hours === 0) return;
      if (Math.abs(hours - left) < Math.abs(best - left)) best = hours;
    });
    return best;
  }

  /** 回复用户弹窗：内容以系统通知送达对方的账号通知列表（启动器账号页 / 网页通知页） */
  function openNotifyDialog(user, { title = '来自管理团队的消息', context = '' } = {}) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="回复 ${BB.esc(user.username)}">
        <h3>回复 @${BB.esc(user.display_name || user.username)}</h3>
        <p class="muted small">${context ? `${BB.esc(context)}<br>` : ''}内容将以系统通知发送到对方的账号通知列表。</p>
        <div class="field">
          <label>内容</label>
          <textarea class="textarea" id="notifyBody" maxlength="500"
                    placeholder="写清楚处理结果或想说明的内容（最多 500 字）"></textarea>
        </div>
        <div class="modal-error" id="notifyError"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" data-act="cancel">取消</button>
          <button class="btn btn-primary btn-sm" data-act="ok">发送</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    document.body.classList.add('modal-open');

    const errorHost = mask.querySelector('#notifyError');
    const close = () => {
      mask.remove();
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };

    const submit = async (button) => {
      const body = mask.querySelector('#notifyBody').value.trim();
      if (!body) {
        errorHost.textContent = '先写点内容再发送';
        return;
      }
      button.disabled = true;
      errorHost.textContent = '';
      try {
        await BB.api(`/api/admin/users/${user.id}/notify`, { method: 'POST', body: { title, body } });
        close();
        BB.toast('已发送，对方会在通知里看到', 'ok');
      } catch (error) {
        button.disabled = false;
        errorHost.textContent = error.message || '发送失败，稍后再试';
      }
    };

    mask.addEventListener('click', (event) => {
      if (event.target === mask) {
        close();
        return;
      }
      const button = event.target.closest('[data-act]');
      if (!button) return;
      if (button.dataset.act === 'cancel') close();
      if (button.dataset.act === 'ok') submit(button);
    });
    document.addEventListener('keydown', onKey);
    mask.querySelector('#notifyBody').focus();
  }

  /** 禁言弹窗：禁止内容 + 理由 + 时间都在这里设，行里只留一颗「禁言」按钮 */
  function openMuteDialog(user) {
    const isMuted = user.status === 'muted';
    const isBanned = user.status === 'banned';
    const scope = BB.muteScopeList(user.mute_scope);
    const hours = guessHours(user);

    const nowText = isMuted
      ? `当前已禁言：禁止${BB.muteScopeLabel(user.mute_scope)} · ${BB.muteUntilText(user.muted_until)}${
          user.mute_reason ? ` · 理由：${BB.esc(user.mute_reason)}` : ''
        }`
      : isBanned
        ? '当前已被封禁。确认禁言后会改为禁言状态，账号可以重新登录。'
        : '禁言后，下面勾选的操作会立刻不能使用，到时间自动恢复。';

    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="禁言 ${BB.esc(user.username)}">
        <h3>禁言 @${BB.esc(user.username)}</h3>
        <p class="muted small">${nowText}</p>
        <div class="field">
          <label>禁止内容</label>
          <div class="check-row">
            ${BB.MUTE_SCOPES.map(
              ([key, label]) =>
                `<label><input type="checkbox" value="${key}"${scope.includes(key) ? ' checked' : ''}>${label}</label>`,
            ).join('')}
          </div>
          <div class="input-hint">至少选一项；三项全选等于禁止全部发言。</div>
        </div>
        <div class="field">
          <label>理由</label>
          <input class="input" id="muteReason" maxlength="100" placeholder="例如：连续发广告，提醒后仍在刷屏"
                 value="${BB.esc(user.mute_reason || '')}">
          <div class="input-hint">理由会显示给被禁言的人，写清楚一点能减少误会。</div>
        </div>
        <div class="field">
          <label>时间</label>
          <select class="select" id="muteHours">
            ${MUTE_HOURS.map(
              ([value, label]) => `<option value="${value}"${value === hours ? ' selected' : ''}>${label}</option>`,
            ).join('')}
          </select>
        </div>
        <div class="modal-error" id="muteError"></div>
        <div class="modal-actions">
          ${isMuted || isBanned ? `<button class="btn btn-ghost btn-sm" data-act="clear">${isBanned ? '解除封禁' : '解除禁言'}</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-act="cancel">取消</button>
          <button class="btn btn-primary btn-sm" data-act="ok">${isMuted ? '更新禁言' : '确认禁言'}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    document.body.classList.add('modal-open');

    const errorHost = mask.querySelector('#muteError');
    const checkboxes = [...mask.querySelectorAll('.check-row input')];
    const close = () => {
      mask.remove();
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };

    const fail = (message) => {
      errorHost.textContent = message;
    };

    const submit = async (button) => {
      const picked = checkboxes.filter((box) => box.checked).map((box) => box.value);
      if (!picked.length) {
        fail('至少要选一项禁止内容');
        return;
      }
      button.disabled = true;
      fail('');
      try {
        await BB.api(`/api/admin/users/${user.id}`, {
          method: 'PATCH',
          body: {
            status: 'muted',
            mute_scope: picked.join(','),
            mute_reason: mask.querySelector('#muteReason').value.trim(),
            mute_hours: Number(mask.querySelector('#muteHours').value),
          },
        });
        close();
        BB.toast(`已禁言 ${user.display_name || user.username}`, 'ok');
        renderUsers();
      } catch (error) {
        button.disabled = false;
        fail(error.message || '操作失败，稍后再试');
      }
    };

    mask.addEventListener('click', async (event) => {
      if (event.target === mask) {
        close();
        return;
      }
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const act = button.dataset.act;
      if (act === 'cancel') {
        close();
        return;
      }
      if (act === 'ok') {
        submit(button);
        return;
      }
      if (act === 'clear') {
        button.disabled = true;
        try {
          await BB.api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { status: 'active' } });
          close();
          BB.toast('已恢复正常', 'ok');
          renderUsers();
        } catch (error) {
          button.disabled = false;
          fail(error.message || '操作失败，稍后再试');
        }
      }
    });

    document.addEventListener('keydown', onKey);
    const first = checkboxes.find((box) => box.checked) || checkboxes[0];
    if (first) first.focus();
  }

  /** 设为管理员前的确认弹窗：列清楚这个身份能做什么，确认后才真正生效 */
  function openGrantAdminDialog(user) {
    const name = user.display_name || user.username;
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal-card modal-wide" role="dialog" aria-modal="true" aria-label="设为管理员">
        <h3>把 ${BB.esc(name)} 设为管理员？</h3>
        <p class="muted small">设为管理员后，TA 马上就能在管理后台做这些事：</p>
        <ul class="power-list">
          ${ADMIN_POWERS.map(
            ([label, text]) => `<li><b>${label}</b><span>${text}</span></li>`,
          ).join('')}
        </ul>
        <p class="power-note">管理员权限覆盖整个论坛，几乎什么都能改；只授予完全信任的人，设错了也可以随时在这里取消。</p>
        <div class="modal-error"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" data-act="cancel">取消</button>
          <button class="btn btn-primary btn-sm" data-act="ok">确认设为管理员</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    document.body.classList.add('modal-open');

    const errorHost = mask.querySelector('.modal-error');
    const close = () => {
      mask.remove();
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };

    mask.addEventListener('click', async (event) => {
      if (event.target === mask) {
        close();
        return;
      }
      const button = event.target.closest('[data-act]');
      if (!button) return;
      if (button.dataset.act === 'cancel') {
        close();
        return;
      }
      if (button.dataset.act !== 'ok') return;
      button.disabled = true;
      errorHost.textContent = '';
      try {
        await BB.api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { role: 'admin' } });
        close();
        BB.toast(`已把 ${name} 设为管理员`, 'ok');
        renderUsers();
      } catch (error) {
        button.disabled = false;
        errorHost.textContent = error.message || '操作失败，稍后再试';
      }
    });

    document.addEventListener('keydown', onKey);
    mask.querySelector('[data-act="ok"]').focus();
  }

  async function renderUsers() {
    const body = document.getElementById('userRows');
    const data = await BB.api(`/api/admin/users?q=${encodeURIComponent(userQuery)}&per_page=50`);
    adminUsers = data.users;
    body.innerHTML = data.users
      .map((user) => {
        const muteTitle = user.status === 'muted'
          ? ` title="禁止${BB.esc(BB.muteScopeLabel(user.mute_scope))} · ${BB.muteUntilText(user.muted_until)}${
              user.mute_reason ? ` · 理由：${BB.esc(user.mute_reason)}` : ''
            }${user.mute_by ? ` · 由 ${BB.esc(user.mute_by)} 操作` : ''}"`
          : '';
        const statusLabel =
          user.status === 'banned'
            ? '<span class="chip chip-danger">封禁</span>'
            : user.status === 'muted'
              ? `<span class="chip chip-warn"${muteTitle}>禁言</span>
                 <div class="small muted">禁止${BB.esc(BB.muteScopeLabel(user.mute_scope))} · ${BB.muteUntilText(user.muted_until)}</div>`
              : '<span class="chip chip-grey">正常</span>';
        const roleLabel =
          user.role === 'admin'
            ? '<span class="chip">管理员</span>'
            : user.role === 'moderator'
              ? '<span class="chip">次级管理员</span>'
              : '<span class="chip chip-grey">成员</span>';
        // 不能改自己的管理权限，自己的行就不给这些按钮
        const selfRow = BB.state.me && BB.state.me.id === user.id;
        // 旧版本设过的次级管理员按管理员处理：只保留「取消」这条路，不再新增
        const isManager = user.role === 'admin' || user.role === 'moderator';
        const roleButtons = BB.isHeadAdmin() && !selfRow
          ? `<button class="btn btn-ghost btn-sm" data-user="${user.id}" data-act="role">${
              isManager ? '取消管理员' : '设为管理员'
            }</button>`
          : '';
        const muteButton = selfRow
          ? ''
          : `<button class="btn ${user.status === 'muted' ? 'btn-primary' : 'btn-ghost'} btn-sm" data-user="${user.id}" data-act="mute">禁言</button>`;
        const notifyButton = selfRow
          ? ''
          : `<button class="btn btn-ghost btn-sm" data-user="${user.id}" data-act="notify">发消息</button>`;
        return `
        <tr>
          <td>
            <a href="/user.html?id=${user.id}" style="display: flex; align-items: center; gap: 8px">
              ${BB.avatar(user, 'avatar-sm')}
              <span>${BB.esc(user.display_name || user.username)}<br><span class="small muted">@${BB.esc(user.username)}</span></span>
            </a>
          </td>
          <td>${roleLabel}</td>
          <td>${statusLabel}</td>
          <td class="small">${BB.num(user.thread_count)} / ${BB.num(user.post_count)}</td>
          <td class="small">${BB.datetime(user.created_at).slice(0, 10)}</td>
          <td class="row-actions">${
            roleButtons || muteButton || notifyButton
              ? `${roleButtons}${muteButton}${notifyButton}`
              : '<span class="muted small">—</span>'
          }</td>
        </tr>`;
      })
      .join('');

    body.querySelectorAll('[data-user]').forEach((button) => {
      button.addEventListener('click', async () => {
        const userId = Number(button.dataset.user);
        const target = adminUsers.find((u) => u.id === userId);
        if (button.dataset.act === 'mute') {
          openMuteDialog(target || { id: userId, username: '', status: 'active' });
          return;
        }
        if (button.dataset.act === 'notify') {
          openNotifyDialog(target || { id: userId, username: '' });
          return;
        }
        if (!target) return;
        // 升管理员：先弹窗把权限一条条摊开，确认后才动手
        if (target.role !== 'admin' && target.role !== 'moderator') {
          openGrantAdminDialog(target);
          return;
        }
        if (!confirm(`取消 ${target.display_name || target.username} 的管理员权限？取消后 TA 将无法再进入管理后台。`)) return;
        try {
          await BB.api(`/api/admin/users/${userId}`, { method: 'PATCH', body: { role: 'user' } });
          BB.toast('已取消管理员权限', 'ok');
          renderUsers();
        } catch (error) {
          BB.toast(error.message, 'error');
        }
      });
    });
  }
});
