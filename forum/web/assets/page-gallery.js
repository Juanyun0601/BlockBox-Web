BB.boot(async () => {
  const grid = document.getElementById('galleryGrid');
  const hint = document.getElementById('galleryHint');
  const uploadInput = document.getElementById('uploadInput');

  if (!BB.state.me) {
    grid.innerHTML = `<div class="empty">登录后才能管理自己的相册。<br><br>
      <a class="btn btn-primary btn-sm" href="${BB.loginLink('/gallery.html')}">去登录</a></div>`;
    uploadInput.disabled = true;
    return;
  }

  const page = Math.max(1, Number(BB.param('page') || 1) || 1);
  const data = await BB.api(`/api/me/uploads?page=${page}&per_page=24`);
  hint.textContent = `共 ${data.pagination.total} 张`;

  grid.innerHTML = data.uploads.length
    ? data.uploads
        .map(
          (item) => `
      <div class="gallery-item" data-id="${item.id}">
        <a class="gallery-thumb" href="${BB.esc(item.url)}" target="_blank" rel="noopener">
          <img src="${BB.esc(item.thumb || item.url)}" alt="上传的图片" loading="lazy">
        </a>
        <div class="gallery-meta">
          <span>${item.width || '?'} × ${item.height || '?'} · ${(item.size / 1024).toFixed(0)} KB</span>
          <span>${BB.datetime(item.created_at)}</span>
        </div>
        <div class="gallery-actions">
          <button type="button" data-act="copy">复制 Markdown</button>
          <button type="button" class="danger" data-act="delete">删除</button>
        </div>
      </div>`,
        )
        .join('')
    : '<div class="empty">还没有上传过图片。发帖时粘贴截图，或点右上角「上传图片」。</div>';

  document.getElementById('pager').innerHTML = BB.pagination(
    data.pagination,
    (target) => `/gallery.html?page=${target}`,
  );

  grid.querySelectorAll('.gallery-item').forEach((card) => {
    const id = Number(card.dataset.id);
    card.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      const link = card.querySelector('.gallery-thumb').getAttribute('href');
      const markdown = `![图片](${link})`;
      try {
        await navigator.clipboard.writeText(markdown);
        BB.toast('已复制 Markdown，可以直接贴进正文', 'ok');
      } catch {
        window.prompt('复制这段 Markdown：', markdown);
      }
    });

    card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm('删除后引用这张图的帖子会显示裂图，确定删除？')) return;
      try {
        await BB.api(`/api/me/uploads/${id}`, { method: 'DELETE' });
        card.remove();
        BB.toast('已删除', 'ok');
      } catch (error) {
        BB.toast(error.message, 'error');
      }
    });
  });

  uploadInput.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      BB.toast('图片超过 4 MB，先压缩一下', 'error');
      return;
    }
    BB.toast('正在上传…');
    try {
      await BB.uploadImage(file);
      BB.toast('上传成功', 'ok');
      setTimeout(() => location.reload(), 400);
    } catch (error) {
      BB.toast(error.message, 'error');
    }
  });
});
