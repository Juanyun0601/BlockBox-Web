BB.boot(async () => {
  const next = BB.param('next') || '/';
  let mode = BB.param('tab') === 'register' ? 'register' : 'login';

  if (BB.state.me) {
    document.getElementById('authNotice').innerHTML = `<div class="notice">你已经以「${BB.esc(
      BB.state.me.display_name || BB.state.me.username,
    )}」的身份登录。正在返回…</div>`;
    setTimeout(() => location.replace(next), 800);
    return;
  }

  const title = document.getElementById('authTitle');
  const sub = document.getElementById('authSub');
  const form = document.getElementById('authForm');
  const errorHost = document.getElementById('authError');
  const confirmField = document.getElementById('confirmField');
  const submit = document.getElementById('submitBtn');

  function applyMode() {
    document.querySelectorAll('.auth-tabs button').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === mode);
    });
    const registering = mode === 'register';
    title.textContent = registering ? '注册方块盒子论坛' : '登录方块盒子论坛';
    sub.textContent = registering
      ? '取个名字，之后就能发帖和回复了。'
      : '用你注册的账号继续参与讨论。';
    confirmField.classList.toggle('hidden', !registering);
    submit.textContent = registering ? '注册并登录' : '登录';
    document.getElementById('password').autocomplete = registering ? 'new-password' : 'current-password';
    BB.showError(errorHost, '');
  }

  document.querySelectorAll('.auth-tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      mode = button.dataset.tab;
      applyMode();
    });
  });

  applyMode();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const confirmValue = document.getElementById('confirm').value;

    if (!username) return BB.showError(errorHost, '请输入用户名');
    if (password.length < 6) return BB.showError(errorHost, '密码至少 6 位');
    if (mode === 'register' && password !== confirmValue) {
      return BB.showError(errorHost, '两次输入的密码不一样');
    }

    submit.disabled = true;
    submit.textContent = mode === 'register' ? '注册中…' : '登录中…';
    try {
      const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const data = await BB.api(path, { method: 'POST', body: { username, password } });
      BB.state.me = data.user;
      if (mode === 'register' && data.first_user) {
        BB.toast('已创建管理员账号，欢迎！', 'ok');
      }
      location.replace(next);
    } catch (error) {
      BB.showError(errorHost, error.message);
      submit.disabled = false;
      submit.textContent = mode === 'register' ? '注册并登录' : '登录';
    }
  });
});
