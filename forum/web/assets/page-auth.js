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
  const emailField = document.getElementById('emailField');
  const codeField = document.getElementById('codeField');
  const emailInput = document.getElementById('email');
  const codeInput = document.getElementById('code');
  const sendCodeBtn = document.getElementById('sendCodeBtn');
  const codeHint = document.getElementById('codeHint');
  const submit = document.getElementById('submitBtn');
  const divider = document.getElementById('oauthDivider');
  const buttons = document.getElementById('oauthButtons');
  const hint = document.getElementById('oauthHint');

  // 注册要填邮箱并过验证码验证；服务端把这条规矩关掉时（REGISTER_EMAIL_REQUIRED=0）
  // 就从「/api/me」带回来的站点信息里读出来，把这两栏收起来，别挡着注册
  const emailRequired = BB.state.site?.register_email_required !== false;
  let codeCooldown = 0;
  let codeTimer = null;

  function tickCooldown() {
    if (codeCooldown > 0) codeCooldown -= 1;
    if (!sendCodeBtn) return;
    if (codeCooldown > 0) {
      sendCodeBtn.disabled = true;
      sendCodeBtn.textContent = `重新发送(${codeCooldown}s)`;
    } else {
      sendCodeBtn.disabled = false;
      sendCodeBtn.textContent = '发送验证码';
      if (codeTimer) {
        clearInterval(codeTimer);
        codeTimer = null;
      }
    }
  }

  function startCooldown() {
    codeCooldown = 60;
    tickCooldown();
    if (!codeTimer) codeTimer = setInterval(tickCooldown, 1000);
  }

  async function sendCode() {
    if (sendCodeBtn.disabled) return;
    const mail = emailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return BB.showError(errorHost, '请先填写正确的邮箱地址');
    }
    BB.showError(errorHost, '');
    sendCodeBtn.disabled = true;
    sendCodeBtn.textContent = '发送中…';
    try {
      await BB.api('/api/auth/register/code', { method: 'POST', body: { email: mail } });
      startCooldown();
      if (codeHint) codeHint.textContent = '验证码已发送，10 分钟内有效；没收到就看看垃圾邮件箱。';
      BB.toast('验证码已发到填的邮箱', 'ok');
      codeInput.focus();
    } catch (error) {
      BB.showError(errorHost, error.message);
      sendCodeBtn.disabled = false;
      sendCodeBtn.textContent = '发送验证码';
    }
  }

  if (sendCodeBtn) sendCodeBtn.addEventListener('click', sendCode);

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
    const showEmail = registering && emailRequired;
    emailField.classList.toggle('hidden', !showEmail);
    codeField.classList.toggle('hidden', !showEmail);
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

  // 第三方登录：只有服务端配好了相应应用的 client id / secret 才显示入口
  const badges = { github: 'GH', littleskin: 'LS' };
  try {
    const data = await BB.api('/api/auth/oauth/providers');
    const enabled = (data?.providers || []).filter((item) => item.enabled);
    if (enabled.length) {
      buttons.innerHTML = enabled
        .map((item) => {
          const label = `使用 ${BB.esc(item.name)} 登录`;
          const href = `/oauth/start/${encodeURIComponent(item.id)}?next=${encodeURIComponent(next)}`;
          return `<a class="oauth-btn oauth-${BB.esc(item.id)}" href="${href}" rel="nofollow">
            <span class="oauth-badge">${BB.esc(badges[item.id] || item.name.slice(0, 1))}</span>
            <span>${label}</span>
          </a>`;
        })
        .join('');
    } else {
      divider?.remove();
      buttons?.remove();
      hint?.remove();
    }
  } catch {
    divider?.remove();
    buttons?.remove();
    hint?.remove();
  }

  // 从授权页回来时可能带着错误（用户拒绝、链接过期等），直接显示在表单上方
  const oauthError = BB.param('oauth_error');
  if (oauthError) {
    BB.showError(errorHost, oauthError);
    const url = new URL(location.href);
    url.searchParams.delete('oauth_error');
    history.replaceState(null, '', url.toString());
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const confirmValue = document.getElementById('confirm').value;
    const registering = mode === 'register';
    const needEmail = registering && emailRequired;
    const mail = emailInput.value.trim();
    const code = codeInput.value.trim();

    if (!username) return BB.showError(errorHost, '请输入用户名');
    if (password.length < 6) return BB.showError(errorHost, '密码至少 6 位');
    if (registering && password !== confirmValue) {
      return BB.showError(errorHost, '两次输入的密码不一样');
    }
    if (needEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return BB.showError(errorHost, '请填写正确的邮箱地址');
    }
    if (needEmail && !/^\d{6}$/.test(code)) {
      return BB.showError(errorHost, '请填写邮箱收到的 6 位数字验证码');
    }

    submit.disabled = true;
    submit.textContent = registering ? '注册中…' : '登录中…';
    try {
      const path = registering ? '/api/auth/register' : '/api/auth/login';
      const body = registering ? { username, password, email: mail, code } : { username, password };
      const data = await BB.api(path, { method: 'POST', body });
      BB.state.me = data.user;
      if (registering && data.first_user) {
        BB.toast('已创建管理员账号，欢迎！', 'ok');
      }
      location.replace(next);
    } catch (error) {
      BB.showError(errorHost, error.message);
      submit.disabled = false;
      submit.textContent = registering ? '注册并登录' : '登录';
    }
  });
});
