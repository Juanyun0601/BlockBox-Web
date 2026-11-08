BB.boot(async () => {
  const input = document.getElementById('searchInput');
  const form = document.getElementById('searchForm');
  const query = (BB.param('q') || '').trim();
  input.value = query;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    location.href = value ? `/search.html?q=${encodeURIComponent(value)}` : '/search.html';
  });

  if (!query) {
    document.getElementById('resultList').innerHTML =
      '<div class="empty">输入关键词开始搜索，比如「Java 找不到」「整合包」「插件」</div>';
    return;
  }

  const page = Math.max(1, Number(BB.param('page') || 1) || 1);
  const T = (text, ...args) => (window.BBF ? BBF.tf(text, ...args) : text);
  document.title = T('搜索：{0} · 方块盒子论坛', query);

  const data = await BB.api(
    `/api/search?q=${encodeURIComponent(query)}&page=${page}&per_page=20`,
  );
  document.getElementById('resultTitle').textContent = T('“{0}” 的搜索结果', query);
  document.getElementById('resultCount').textContent = `共 ${data.pagination.total} 条`;

  document.getElementById('resultList').innerHTML = data.results.length
    ? data.results.map((item) => BB.threadRow(item, { showSnippet: true })).join('')
    : `<div class="empty">没有找到和「${BB.esc(query)}」相关的主题。<br><br>
         <a class="btn btn-primary btn-sm" href="/new.html">发个新帖问问</a></div>`;

  document.getElementById('pager').innerHTML = BB.pagination(
    data.pagination,
    (target) => `/search.html?q=${encodeURIComponent(query)}&page=${target}`,
  );
});
