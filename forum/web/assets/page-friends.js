/**
 * 好友与私信页：
 * 左侧三个页签（好友 / 申请 / 添加好友），右侧聊天面板；
 * 每 4 秒轮询一次 /api/messages/poll，同时刷新角标、会话列表和当前聊天的新消息。
 */
BB.boot(async () => {
  const layout = document.getElementById('friendsLayout');
  const sideBody = document.getElementById('friendSideBody');
  const refreshBtn = document.getElementById('friendsRefresh');

  if (!BB.state.me) {
    refreshBtn.hidden = true;
    layout.innerHTML =
      `<div class="empty" style="grid-column: 1 / -1">登录后才能查看好友和私信。
        <a class="btn btn-primary btn-sm" style="margin-left: 10px" href="${BB.loginLink('/friends.html')}">去登录</a></div>`;
    return;
  }

  // ------------------------------------------------------------ 状态

  let data = { friends: [], incoming: [], outgoing: [], total_unread: 0 };
  let tab = 'friends';
  let peer = null;            // 当前会话的好友
  const msgs = new Map();     // 当前会话的消息 id -> msg
  let lastId = 0;             // 已拿到的最大消息 id
  let hasMore = false;
  let sending = false;
  let pollBusy = false;
  let imageUploading = false;
  let replyTarget = null;     // 正在引用的消息（null = 没有）
  let searchResults = [];     // 「添加好友」页签的搜索结果

  const esc = BB.esc;
  const EMOJIS = ['😀','😁','😂','🤣','😊','😍','😘','😜','🤔','😎','😴','😭','🥺','😡','🤯','🙄',
    '👋','👍','👎','👌','🙏','💪','🤝','✌️','🎉','🔥','❤️','💔','🌹','⭐','🌙','☀️',
    '🎮','⛏️','🏠','🐷','🐮','🐶','🐱','🐭','🍕','🍔','🍺','☕','🎁','💰','⚡','💎'];
  const chatMain = document.getElementById('chatMain');
  const chatEmpty = document.getElementById('chatEmpty');
  const chatHead = document.getElementById('chatHead');
  const chatMsgs = document.getElementById('chatMsgs');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');
  const chatSend = document.getElementById('chatSend');
  const chatMore = document.getElementById('chatMore');

  // ------------------------------------------------------------ 小工具

  function hhmm(seconds) {
    const date = new Date(seconds * 1000);
    const pad = (value) => String(value).padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const today = new Date();
    if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) {
      return time;
    }
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
  }

  /** 顶栏「好友」角标 = 未读私信 + 待处理申请 */
  function syncBadge() {
    BB.state.friendUnread = Number(data.total_unread || 0) + data.incoming.length;
    BB.syncFriendNav();
  }

  function friendById(id) {
    return data.friends.find((item) => item.id === id) || null;
  }

  /** 会话列表 / 引用条里的消息摘要 */
  function messagePreview(msg) {
    if (msg.kind === 'withdrawn') return '撤回了一条消息';
    if (msg.kind === 'image') return '[图片]';
    return msg.body;
  }

  function setMessageReply(msg) {
    replyTarget = msg;
    const name = msg.mine ? '我' : (peer ? peer.display_name : '');
    const text = `回复 ${name}：${messagePreview(msg)}`;
    document.getElementById('chatReplyText').textContent = text;
    document.getElementById('chatReplyText').title = text;
    document.getElementById('chatReply').hidden = false;
    chatInput.focus();
  }

  function clearReply() {
    replyTarget = null;
    document.getElementById('chatReply').hidden = true;
  }

  function toggleEmojiPanel() {
    const panel = document.getElementById('emojiPanel');
    if (!panel.dataset.built) {
      panel.innerHTML = EMOJIS.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
      panel.dataset.built = '1';
    }
    panel.hidden = !panel.hidden;
  }

  async function withdrawMessage(id) {
    if (!window.confirm('确定撤回这条消息吗？')) return;
    try {
      await BB.api(`/api/messages/${id}`, { method: 'DELETE' });
    } catch (error) {
      BB.toast(error.message || '撤回失败', 'error');
    }
    if (peer) openChat(peer);
  }

  async function sendImageFile(file) {
    if (!peer || imageUploading) return;
    if (file.size > 4 * 1024 * 1024) {
      BB.toast('图片超过 4 MB，先压缩一下吧', 'error');
      return;
    }
    imageUploading = true;
    BB.toast('正在上传图片…');
    try {
      const uploaded = await BB.uploadImage(file);
      const res = await BB.api(`/api/messages/${peer.id}`, {
        method: 'POST',
        body: { kind: 'image', image: uploaded, reply_to: replyTarget ? replyTarget.id : 0 },
      });
      appendMessages([res.message]);
      scrollBottom(true);
      clearReply();
    } catch (error) {
      BB.toast(error.message || '发送失败，请稍后再试', 'error');
    } finally {
      imageUploading = false;
    }
  }

  async function reload() {
    data = await BB.api('/api/friends');
    syncBadge();
  }

  // ------------------------------------------------------------ 左侧列表

  function friendRow(f) {
    const unread = f.unread ? `<span class="fr-badge">${f.unread > 99 ? '99+' : f.unread}</span>` : '';
    const time = f.last_message ? `<span class="fr-time">${esc(hhmm(f.last_message.created_at))}</span>` : '';
    const lastText = f.last_message ? messagePreview(f.last_message) : '';
    const preview = f.last_message
      ? esc(`${f.last_message.mine && f.last_message.kind !== 'withdrawn' ? '我：' : ''}${lastText}`)
      : '还没有聊过天';
    return `<div class="fr-row${peer && peer.id === f.id ? ' active' : ''}" data-peer="${f.id}" title="打开会话">
      ${BB.avatar(f, 'avatar-sm')}
      <div class="fr-main">
        <div class="fr-top">
          <span class="fr-name">${esc(f.display_name)}</span>
          <span class="fr-online${f.online ? ' on' : ''}" title="${f.online ? '在线' : `最近活跃 ${BB.time(f.last_seen_at)}`}"></span>
          ${unread}${time}
        </div>
        <div class="fr-preview">${preview}</div>
      </div>
    </div>`;
  }

  function requestRows() {
    if (data.incoming.length === 0 && data.outgoing.length === 0) {
      return '<div class="empty">没有待处理的好友申请</div>';
    }
    const incoming = data.incoming.map((item) => `
      <div class="fr-row" data-user="${item.user.id}">
        ${BB.avatar(item.user, 'avatar-sm')}
        <div class="fr-main">
          <div class="fr-top"><span class="fr-name">${esc(item.user.display_name)}</span></div>
          <div class="fr-preview">${esc(BB.time(item.created_at))}申请加你为好友</div>
        </div>
        <div class="fr-actions">
          <button class="btn btn-primary btn-sm" data-accept="${item.id}">同意</button>
          <button class="btn btn-ghost btn-sm" data-decline="${item.id}">拒绝</button>
        </div>
      </div>`);
    const outgoing = data.outgoing.map((item) => `
      <div class="fr-row" data-user="${item.user.id}">
        ${BB.avatar(item.user, 'avatar-sm')}
        <div class="fr-main">
          <div class="fr-top"><span class="fr-name">${esc(item.user.display_name)}</span></div>
          <div class="fr-preview">等待对方同意</div>
        </div>
        <div class="fr-actions"><button class="btn btn-ghost btn-sm" data-withdraw="${item.id}">撤回</button></div>
      </div>`);
    return incoming.join('') + outgoing.join('');
  }

  /** 搜索结果行：按钮文案按当前好友关系决定 */
  function addActionButton(user) {
    if (data.friends.some((item) => item.id === user.id)) {
      return '<button class="btn btn-ghost btn-sm" disabled>已是好友</button>';
    }
    const incoming = data.incoming.find((item) => item.user.id === user.id);
    if (incoming) {
      return `<button class="btn btn-primary btn-sm" data-accept="${incoming.id}">同意申请</button>`;
    }
    const outgoing = data.outgoing.find((item) => item.user.id === user.id);
    if (outgoing) {
      return `<button class="btn btn-ghost btn-sm" data-withdraw="${outgoing.id}">撤回申请</button>`;
    }
    return `<button class="btn btn-primary btn-sm" data-add="${user.id}">加好友</button>`;
  }

  function renderSearchResults() {
    const host = document.getElementById('frSearchResults');
    if (!host) return;
    if (!searchResults.length) {
      host.innerHTML = '<div class="empty">没有找到这个用户</div>';
      return;
    }
    host.innerHTML = searchResults.map((user) => `
      <div class="fr-row" data-user="${user.id}">
        ${BB.avatar(user, 'avatar-sm')}
        <div class="fr-main">
          <div class="fr-top"><span class="fr-name">${esc(user.display_name)}</span></div>
          <div class="fr-preview">@${esc(user.username)}</div>
        </div>
        <div class="fr-actions">${addActionButton(user)}</div>
      </div>`).join('');
  }

  function renderSide() {
    if (tab === 'add' && document.activeElement && document.activeElement.id === 'frSearchInput') {
      return; // 正在输入时不要重建，避免打断输入
    }
    const scrollTop = sideBody.scrollTop;
    if (tab === 'friends') {
      sideBody.innerHTML = data.friends.length
        ? data.friends.map(friendRow).join('')
        : '<div class="empty">还没有好友，去「添加好友」找一个吧</div>';
    } else if (tab === 'requests') {
      sideBody.innerHTML = requestRows();
    } else {
      sideBody.innerHTML = `
        <div class="fr-search">
          <input class="input" id="frSearchInput" type="search" maxlength="24"
                 placeholder="输入用户名或昵称搜索" value="${esc(document.getElementById('frSearchInput')?.value || '')}">
        </div>
        <div id="frSearchResults">${searchResults.length ? '' : '<div class="empty">搜到玩家后点「加好友」，对方同意就能聊天了</div>'}</div>`;
      renderSearchResults();
    }
    sideBody.scrollTop = scrollTop;
    document.getElementById('friendsTabDot').hidden = !(data.total_unread > 0);
    document.getElementById('reqTabDot').hidden = !(data.incoming.length > 0);
  }

  // ------------------------------------------------------------ 右侧聊天

  function messageHtml(msg) {
    if (msg.kind === 'withdrawn') {
      return `<div class="msg-withdrawn">${esc(msg.mine ? '你撤回了一条消息' : '对方撤回了一条消息')}</div>`;
    }
    const quote = msg.reply_to
      ? `<div class="msg-quote">回复 ${esc(msg.reply_mine ? '我' : (peer ? peer.display_name : ''))}：${esc(msg.reply_body)}</div>`
      : '';
    const inner = msg.kind === 'image'
      ? `${quote}<a class="img-link" href="${esc(msg.image)}" data-full="${esc(msg.image)}"><img class="msg-image" src="${esc(msg.image)}" alt="图片" loading="lazy"></a>${msg.body ? `<div class="msg-text">${esc(msg.body)}</div>` : ''}`
      : `${quote}<div class="msg-text">${esc(msg.body)}</div>`;
    const canWithdraw = msg.mine && Date.now() / 1000 - msg.created_at <= 600;
    const actions = `<span class="msg-actions">
        <button type="button" data-reply="${msg.id}" title="回复">↩</button>
        ${msg.kind === 'text' && msg.body ? `<button type="button" data-copy="${msg.id}" title="复制文字">⧉</button>` : ''}
        ${canWithdraw ? `<button type="button" data-withdraw-msg="${msg.id}" title="撤回">✕</button>` : ''}
      </span>`;
    const time = `<span class="msg-time">${esc(hhmm(msg.created_at))}${msg.mine && msg.read_at ? ' · 已读' : ''}</span>`;
    if (msg.mine) return `<div class="msg-row mine" data-mid="${msg.id}">${actions}<div class="msg-body">${inner}${time}</div></div>`;
    return `<div class="msg-row theirs" data-mid="${msg.id}">${BB.avatar(peer, 'avatar-xs')}<div class="msg-body">${inner}${time}</div>${actions}</div>`;
  }

  function renderMessages() {
    const list = [...msgs.values()].sort((a, b) => a.id - b.id);
    chatMsgs.innerHTML = list.length ? list.map(messageHtml).join('') : '<div class="empty">还没有消息，打个招呼吧</div>';
    chatMore.hidden = !hasMore;
  }

  function nearBottom() {
    return chatMsgs.scrollHeight - chatMsgs.scrollTop - chatMsgs.clientHeight < 80;
  }

  function scrollBottom(force) {
    if (force || nearBottom()) chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  function appendMessages(list) {
    let added = false;
    for (const msg of list) {
      if (!msgs.has(msg.id)) {
        msgs.set(msg.id, msg);
        if (msg.id > lastId) lastId = msg.id;
        added = true;
      }
    }
    if (added) {
      renderMessages();
      scrollBottom(false);
    }
    return added;
  }

  function renderChatHead() {
    const status = peer.online ? '在线' : `最近活跃 ${BB.time(peer.last_seen_at || 0)}`;
    chatHead.innerHTML = `
      ${BB.avatar(peer, 'avatar-sm')}
      <div>
        <div class="chat-head-name">${esc(peer.display_name)}</div>
        <div class="chat-head-status">${esc(status)}</div>
      </div>
      <div class="chat-head-actions">
        <a class="btn btn-ghost btn-sm" href="/user.html?id=${peer.id}">主页</a>
        <button class="btn btn-danger btn-sm" data-remove-friend>删除好友</button>
      </div>`;
  }

  async function openChat(friend) {
    peer = { ...friend };
    msgs.clear();
    lastId = 0;
    hasMore = false;
    clearReply();
    document.getElementById('emojiPanel').hidden = true;
    chatEmpty.hidden = true;
    chatMain.hidden = false;
    chatMsgs.innerHTML = '<div class="empty">正在加载消息…</div>';
    renderChatHead();
    renderSide();
    try {
      const res = await BB.api(`/api/messages/${peer.id}`);
      peer = { ...peer, ...res.user };
      for (const msg of res.messages) {
        msgs.set(msg.id, msg);
        if (msg.id > lastId) lastId = msg.id;
      }
      hasMore = !!res.has_more;
      renderChatHead();
      renderMessages();
      scrollBottom(true);
      const mine = friendById(peer.id);
      if (mine) {
        // 立刻清零这个好友的未读并同步总角标，不用等下一轮轮询
        data.total_unread = Math.max(0, Number(data.total_unread || 0) - Number(mine.unread || 0));
        mine.unread = 0;
      }
      syncBadge();
      renderSide();
    } catch (error) {
      chatMsgs.innerHTML = `<div class="empty">${esc(error.message || '加载失败')}</div>`;
    }
  }

  function closeChat() {
    peer = null;
    msgs.clear();
    chatMain.hidden = true;
    chatEmpty.hidden = false;
    renderSide();
  }

  // ------------------------------------------------------------ 动作

  async function sendMessage() {
    const body = chatInput.value.trim();
    if (!body || sending || !peer) return;
    sending = true;
    chatSend.disabled = true;
    try {
      const res = await BB.api(`/api/messages/${peer.id}`, {
        method: 'POST',
        body: { body, reply_to: replyTarget ? replyTarget.id : 0 },
      });
      chatInput.value = '';
      appendMessages([res.message]);
      scrollBottom(true);
      clearReply();
    } catch (error) {
      if (error.status === 403) {
        BB.toast(error.message || '发送失败', 'error');
        await reload().catch(() => {});
        closeChat();
      } else {
        BB.toast(error.message || '发送失败，请稍后再试', 'error');
      }
    } finally {
      sending = false;
      chatSend.disabled = false;
      chatInput.focus();
    }
  }

  async function loadOlder() {
    if (!peer || !hasMore || loadingOlder) return;
    loadingOlder = true;
    const button = document.getElementById('chatMoreBtn');
    if (button) button.disabled = true;
    try {
      const oldest = Math.min(...msgs.keys());
      const res = await BB.api(`/api/messages/${peer.id}?before_id=${oldest}`);
      const keep = chatMsgs.scrollHeight - chatMsgs.scrollTop;
      for (const msg of res.messages) msgs.set(msg.id, msg);
      hasMore = !!res.has_more;
      renderMessages();
      chatMsgs.scrollTop = chatMsgs.scrollHeight - keep;
    } catch (error) {
      BB.toast(error.message || '加载失败', 'error');
    } finally {
      loadingOlder = false;
      if (button) button.disabled = false;
    }
  }

  let loadingOlder = false;

  async function acceptRequest(id) {
    try {
      await BB.api(`/api/friends/requests/${id}/accept`, { method: 'POST' });
      BB.toast('已同意好友申请', 'ok');
    } catch (error) {
      BB.toast(error.message || '操作失败', 'error');
    }
    await reload().catch(() => {});
    renderSide();
  }

  async function declineRequest(id) {
    try {
      await BB.api(`/api/friends/requests/${id}/decline`, { method: 'POST' });
    } catch (error) {
      BB.toast(error.message || '操作失败', 'error');
    }
    await reload().catch(() => {});
    renderSide();
  }

  async function withdrawRequest(id) {
    try {
      await BB.api(`/api/friends/requests/${id}`, { method: 'DELETE' });
    } catch (error) {
      BB.toast(error.message || '操作失败', 'error');
    }
    await reload().catch(() => {});
    renderSide();
  }

  async function addFriend(userId) {
    try {
      const res = await BB.api('/api/friends/requests', { method: 'POST', body: { user_id: userId } });
      BB.toast(res.status === 'friends' ? '对方也申请了你，已经成为好友' : '申请已发出，等对方同意', 'ok');
    } catch (error) {
      BB.toast(error.message || '操作失败', 'error');
    }
    await reload().catch(() => {});
    renderSearchResults();
    renderSide();
  }

  async function removeFriend() {
    if (!peer || !window.confirm(`确定删除好友「${peer.display_name}」吗？聊天记录将不再可见。`)) return;
    try {
      await BB.api(`/api/friends/${peer.id}`, { method: 'DELETE' });
      BB.toast('已删除好友', 'ok');
    } catch (error) {
      BB.toast(error.message || '操作失败', 'error');
    }
    closeChat();
    await reload().catch(() => {});
    renderSide();
  }

  let searchTimer = 0;
  async function doSearch(keyword) {
    const query = keyword.trim();
    if (!query) {
      searchResults = [];
      renderSearchResults();
      return;
    }
    try {
      const res = await BB.api(`/api/users/search?q=${encodeURIComponent(query)}`);
      searchResults = res.users || [];
      renderSearchResults();
    } catch {
      /* 搜索失败不打扰用户，清空结果即可 */
    }
  }

  // ------------------------------------------------------------ 轮询

  async function poll() {
    if (document.hidden || pollBusy) return;
    pollBusy = true;
    try {
      const params = new URLSearchParams();
      if (peer) {
        params.set('peer_id', peer.id);
        if (lastId > 0) params.set('after_id', lastId);
      }
      const res = await BB.api(`/api/messages/poll?${params}`);
      data.friends = res.friends || [];
      data.total_unread = Number(res.total_unread || 0);
      const incomingCount = Number(res.incoming_requests || 0);
      if (incomingCount !== data.incoming.length && tab === 'requests') {
        await reload().catch(() => {}); // 申请页开着时把列表也刷出来
      } else {
        data.incoming.length = Math.min(data.incoming.length, incomingCount);
      }
      if (peer && res.messages && res.messages.length) appendMessages(res.messages);
      const mine = peer && friendById(peer.id);
      if (mine && mine.unread > 0) { mine.unread = 0; }
      renderSide();
      syncBadge();
    } catch {
      /* 网络抖动忽略，等下一轮 */
    } finally {
      pollBusy = false;
    }
  }

  setInterval(poll, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  // ------------------------------------------------------------ 事件

  document.getElementById('friendTabs').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-tab]');
    if (!button) return;
    tab = button.dataset.tab;
    document.querySelectorAll('#friendTabs button').forEach((item) => item.classList.toggle('active', item === button));
    if (tab !== 'friends') await reload().catch(() => {});
    renderSide();
  });

  refreshBtn.addEventListener('click', async () => {
    await reload().catch(() => {});
    renderSide();
    if (peer) openChat(peer);
  });

  sideBody.addEventListener('click', (event) => {
    if (event.target.closest('button')) return; // 按钮有自己的 data-* 处理
    const row = event.target.closest('[data-peer]');
    if (row) {
      const friend = friendById(Number(row.dataset.peer));
      if (friend) openChat(friend);
      return;
    }
  });

  sideBody.addEventListener('click', async (event) => {
    const accept = event.target.closest('[data-accept]');
    if (accept) return acceptRequest(accept.dataset.accept);
    const decline = event.target.closest('[data-decline]');
    if (decline) return declineRequest(decline.dataset.decline);
    const withdraw = event.target.closest('[data-withdraw]');
    if (withdraw) return withdrawRequest(withdraw.dataset.withdraw);
    const add = event.target.closest('[data-add]');
    if (add) return addFriend(Number(add.dataset.add));
  });

  sideBody.addEventListener('input', (event) => {
    if (event.target.id !== 'frSearchInput') return;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => doSearch(event.target.value), 300);
  });
  sideBody.addEventListener('keydown', (event) => {
    if (event.target.id === 'frSearchInput' && event.key === 'Enter') {
      event.preventDefault();
      window.clearTimeout(searchTimer);
      doSearch(event.target.value);
    }
  });

  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage();
  });
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  document.getElementById('chatMoreBtn').addEventListener('click', loadOlder);
  document.getElementById('chatEmoji').addEventListener('click', toggleEmojiPanel);
  document.getElementById('chatReplyCancel').addEventListener('click', clearReply);
  document.getElementById('chatImage').addEventListener('click', () => document.getElementById('chatFileInput').click());
  document.getElementById('chatFileInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) sendImageFile(file);
    event.target.value = '';
  });
  document.getElementById('emojiPanel').addEventListener('click', (event) => {
    const button = event.target.closest('[data-emoji]');
    if (!button) return;
    chatInput.value += button.dataset.emoji;
    document.getElementById('emojiPanel').hidden = true;
    chatInput.focus();
  });
  chatMsgs.addEventListener('click', (event) => {
    const replyButton = event.target.closest('[data-reply]');
    if (replyButton) {
      const msg = msgs.get(Number(replyButton.dataset.reply));
      if (msg) setMessageReply(msg);
      return;
    }
    const copyButton = event.target.closest('[data-copy]');
    if (copyButton) {
      const msg = msgs.get(Number(copyButton.dataset.copy));
      if (msg) navigator.clipboard.writeText(msg.body).then(() => BB.toast('已复制', 'ok'));
      return;
    }
    const withdrawButton = event.target.closest('[data-withdraw-msg]');
    if (withdrawButton) withdrawMessage(Number(withdrawButton.dataset.withdrawMsg));
  });
  chatInput.addEventListener('paste', (event) => {
    const files = Array.from((event.clipboardData && event.clipboardData.files) || [])
      .filter((file) => file.type.startsWith('image/'));
    if (files.length > 0) {
      event.preventDefault();
      sendImageFile(files[0]);
    }
  });
  chatHead.addEventListener('click', (event) => {
    if (event.target.closest('[data-remove-friend]')) removeFriend();
  });

  // ------------------------------------------------------------ 启动

  await reload().catch(() => {});
  renderSide();

  const peerId = Number(BB.param('peer')) || 0;
  if (peerId) {
    const friend = friendById(peerId);
    openChat(friend || { id: peerId, username: '', display_name: '…', avatar: '', online: false, last_seen_at: 0 });
  }
});
