/* 我的方块 —— 每日签到 / 签到记录 / 购买方块 */
BB.boot(async () => {
  if (!BB.state.me) {
    location.replace(BB.loginLink('/points.html'));
    return;
  }

  const me = BB.state.me;
  const profileLink = document.getElementById('profileLink');
  if (profileLink) profileLink.href = `/user.html?id=${me.id}`;

  const balanceEl = document.getElementById('pointsBalance');
  const streakEl = document.getElementById('pointsStreak');
  const checkinBtn = document.getElementById('checkinBtn');
  const weekEl = document.getElementById('checkinWeek');
  const weekHint = document.getElementById('pointsWeekHint');
  const giftCard = document.getElementById('pointsGiftCard');
  const historyEl = document.getElementById('pointsHistory');
  const historyHint = document.getElementById('pointsHistoryHint');
  const makeupCountEl = document.getElementById('makeupCount');
  const makeupHintEl = document.getElementById('makeupHint');
  const makeupDescEl = document.getElementById('makeupDesc');
  const buyMakeupBtn = document.getElementById('buyMakeupBtn');
  const useMakeupBtn = document.getElementById('useMakeupBtn');

  // 购买方块
  const shopCard = document.getElementById('pointsShop');
  const shopGrid = document.getElementById('shopGrid');
  const shopHint = document.getElementById('shopHint');
  const shopNote = document.getElementById('shopNote');
  const shopPay = document.getElementById('shopPay');
  const shopPayTitle = document.getElementById('shopPayTitle');
  const shopPayText = document.getElementById('shopPayText');
  const shopPayLink = document.getElementById('shopPayLink');
  const shopPayCheck = document.getElementById('shopPayCheck');
  const shopPayCancel = document.getElementById('shopPayCancel');

  let state = null;
  let busy = false;
  let shop = null;
  let paying = null; // { outTradeNo, points, packageName, timer, tries }
  const RETURN_PARAM = new URLSearchParams(location.search).get('pay') || '';
  /** 档位展示要用准确数字（BB.num 会把 3300 缩成 3.3k，买方块时看着容易误会） */
  const exact = (value) => Number(value || 0).toLocaleString('zh-CN');

  async function load() {
    try {
      state = await BB.api('/api/points');
      render(state);
    } catch (error) {
      weekEl.innerHTML = `<div class="empty">${BB.esc(error.message || '签到信息加载失败')}</div>`;
      historyEl.innerHTML = '<div class="empty">签到记录加载失败，刷新页面试试。</div>';
    }
  }

  function render(data) {
    balanceEl.textContent = BB.num(data.points);
    streakEl.textContent =
      data.streak > 0
        ? `连续签到 ${data.streak} 天${data.sunday && data.sunday.is_sunday ? ' · 今天周日' : ''}`
        : '今天签到，开始你的连续记录';

    if (data.checked_in_today) {
      checkinBtn.disabled = true;
      checkinBtn.textContent = '今天已签到';
    } else {
      checkinBtn.disabled = false;
      checkinBtn.textContent = `签到领 ${data.reward_today} 方块`;
    }

    weekEl.innerHTML = (data.week || [])
      .map((day) => {
        const label = day.checked ? '已领' : day.current ? '今天' : '待领';
        return `<div class="checkin-day-card${day.checked ? ' checked' : ''}${day.current ? ' current' : ''}">
          <span class="day-label">第 ${day.day} 天</span>
          <b class="day-reward">+${day.reward}</b>
          <span class="day-state">${label}</span>
        </div>`;
      })
      .join('');
    weekHint.textContent =
      data.streak >= 7
        ? `已连续 ${data.streak} 天，之后每天都是 20 方块`
        : data.checked_in_today
          ? `明天可得 ${data.reward_next} 方块`
          : `今天可得 ${data.reward_today} 方块`;

    const gift = data.sunday || { is_sunday: false, gift_pending: 0 };
    const giftTitle = giftCard.querySelector('b');
    const giftText = giftCard.querySelector('p');
    if (giftTitle) giftTitle.textContent = gift.gift_pending > 0 ? `神秘礼包 × ${gift.gift_pending}` : '每周天神秘礼包';
    if (giftText) {
      giftText.textContent =
        gift.gift_pending > 0
          ? '礼包已经记在你的账号上，内容开放后可以直接开启。'
          : gift.is_sunday
            ? '今天是周日，签到后就能收到本周的神秘礼包（内容即将上线）。'
            : '每周天签到都会收到一份神秘礼包，内容正在准备中。';
    }
    giftCard.classList.toggle('is-sunday', !!gift.is_sunday);

    const makeup = data.makeup || {};
    const cards = Number(data.makeup_cards) || 0;
    const price = Number(makeup.price) || 20;
    makeupCountEl.textContent = cards;
    makeupHintEl.textContent = makeup.yesterday ? `昨天：${makeup.yesterday}` : '';
    buyMakeupBtn.textContent = `购买补签卡（${price} 方块）`;
    buyMakeupBtn.disabled = !makeup.can_buy;
    buyMakeupBtn.title = makeup.can_buy ? '' : '方块不够，先签到攒一些吧';
    useMakeupBtn.disabled = !makeup.can_use;
    if (makeup.yesterday_checked) useMakeupBtn.textContent = '昨天已签到';
    else if (cards < 1) useMakeupBtn.textContent = '先买一张补签卡';
    else useMakeupBtn.textContent = '补签昨天';
    makeupDescEl.textContent = makeup.yesterday_checked
      ? '昨天已经签到过了，不用补签。'
      : cards > 0
        ? '用一张补签卡补上昨天的签到，连续记录接着算。'
        : `昨天漏签时用一张补上，连续签到接着算；每张 ${price} 方块。`;

    const history = data.history || [];
    historyHint.textContent = data.total_checkins > 0 ? `共 ${data.total_checkins} 次签到` : '';
    historyEl.innerHTML = history.length
      ? `<div class="points-history">
          ${history
            .map(
              (row) => `<div class="points-history-row">
                <span class="points-history-day">${BB.esc(row.day)}</span>
                <span class="points-history-streak">连续第 ${row.streak_day} 天</span>
                ${row.sunday_gift ? '<span class="chip chip-warn">神秘礼包</span>' : ''}
                <b class="points-history-amount">+${row.points} 方块</b>
              </div>`,
            )
            .join('')}
        </div>`
      : '<div class="empty">还没有签到记录，今天签到就能领第一笔方块。</div>';
  }

  checkinBtn.addEventListener('click', async () => {
    if (busy || !state || state.checked_in_today) return;
    busy = true;
    checkinBtn.disabled = true;
    checkinBtn.textContent = '签到中…';
    try {
      const result = await BB.api('/api/points/check-in', { method: 'POST', body: {} });
      state = result;
      BB.setPoints(result.points);
      render(result);
      BB.toast(
        result.sunday_gift
          ? `签到成功：+${result.awarded} 方块，神秘礼包已记到账号上`
          : `签到成功：+${result.awarded} 方块，连续签到第 ${result.streak_day} 天`,
        'ok',
      );
    } catch (error) {
      if (error.code === 'already_checked_in') {
        await load();
      } else {
        checkinBtn.disabled = false;
        checkinBtn.textContent = '签到';
      }
      BB.toast(error.message || '签到失败，稍后再试', 'error');
    } finally {
      busy = false;
    }
  });

  buyMakeupBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    buyMakeupBtn.disabled = true;
    try {
      const result = await BB.api('/api/points/makeup-card/buy', { method: 'POST', body: {} });
      state = result;
      BB.setPoints(result.points);
      render(result);
      BB.toast('已经买到一张补签卡', 'ok');
    } catch (error) {
      BB.toast(error.message || '购买失败，稍后再试', 'error');
      if (state) render(state);
    } finally {
      busy = false;
    }
  });

  useMakeupBtn.addEventListener('click', async () => {
    if (busy || !state || !state.makeup || !state.makeup.can_use) return;
    const day = state.makeup.yesterday || '昨天';
    if (!window.confirm(`用一张补签卡补签 ${day}？`)) return;
    busy = true;
    useMakeupBtn.disabled = true;
    try {
      const result = await BB.api('/api/points/makeup', { method: 'POST', body: {} });
      state = result;
      BB.setPoints(result.points);
      render(result);
      const parts = [`补签成功：+${result.awarded} 方块`];
      if (result.today_bonus > 0) parts.push(`今天连续奖励补差 +${result.today_bonus} 方块`);
      if (result.sunday_gift) parts.push('神秘礼包已记到账号上');
      BB.toast(parts.join('，'), 'ok');
    } catch (error) {
      BB.toast(error.message || '补签失败，稍后再试', 'error');
      await load();
    } finally {
      busy = false;
    }
  });

  /* ── 购买方块 ─────────────────────────────────────────── */

  function stopPayPoll() {
    if (paying && paying.timer) {
      clearInterval(paying.timer);
      paying.timer = null;
    }
  }

  function hidePayPanel() {
    stopPayPoll();
    paying = null;
    if (shopPay) shopPay.hidden = true;
  }

  function renderShop(data) {
    shop = data;
    if (!shopCard) return;
    const packages = data.packages || [];
    shopCard.hidden = !data.enabled || packages.length === 0;
    if (!data.enabled) {
      if (shopNote) shopNote.textContent = data.note || '充值通道还没开通。';
      return;
    }
    if (shopHint) shopHint.textContent = data.methods && data.methods.length ? '' : '支持支付宝 / 微信';
    if (shopNote) shopNote.textContent = data.note || '';
    shopGrid.innerHTML = packages
      .map(
        (item) => `<div class="shop-card" data-id="${BB.esc(item.id)}">
          <span class="shop-name">${BB.esc(item.name)}</span>
          <div class="shop-points"><b>${exact(item.points)}</b><span>方块</span></div>
          <span class="shop-price">¥${BB.esc(item.price)}</span>
          <button class="btn btn-primary shop-buy" type="button" data-id="${BB.esc(item.id)}">购买</button>
        </div>`,
      )
      .join('');
    shopGrid.querySelectorAll('.shop-buy').forEach((btn) => {
      btn.addEventListener('click', () => buy(btn.dataset.id, btn));
    });
  }

  async function loadShop() {
    try {
      renderShop(await BB.api('/api/points/shop'));
    } catch (error) {
      if (shopCard) shopCard.hidden = true;
    }
  }

  async function buy(packageId, btn) {
    if (busy || !shop || !shop.enabled) return;
    busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '正在下单…';
    }
    try {
      const result = await BB.api('/api/points/shop/order', {
        method: 'POST',
        body: { package: packageId },
      });
      startPayPoll(result.order || {}, result.pay_url || '');
      if (result.pay_url) window.open(result.pay_url, '_blank', 'noopener');
    } catch (error) {
      BB.toast(error.message || '下单失败，稍后再试', 'error');
    } finally {
      busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = '购买';
      }
    }
  }

  function startPayPoll(order, payUrl) {
    stopPayPoll();
    paying = { outTradeNo: order.out_trade_no || '', points: order.points || 0, timer: null, tries: 0 };
    if (!shopPay) return;
    shopPay.hidden = false;
    shopPayTitle.textContent = `${order.package_name || ''} ${exact(order.points)} 方块 · ¥${order.price || ''}`;
    shopPayText.textContent = payUrl
      ? '没弹出支付页的话可以点「打开支付页」；付款完成后方块自动到账。'
      : '订单已创建，正在等待支付结果。';
    shopPayLink.href = payUrl || '#';
    shopPayLink.hidden = !payUrl;
    shopPayCheck.disabled = false;
    if (paying.outTradeNo) paying.timer = setInterval(checkPay, 3000);
  }

  async function checkPay(manual) {
    if (!paying || !paying.outTradeNo) return;
    const no = paying.outTradeNo;
    paying.tries += 1;
    try {
      const result = await BB.api(`/api/points/shop/order/${encodeURIComponent(no)}`);
      if (!paying || paying.outTradeNo !== no) return;
      const order = result.order || {};
      if (order.status === 'paid') {
        const gained = Number(order.points) || paying.points || 0;
        hidePayPanel();
        BB.setPoints(result.points);
        BB.toast(`支付成功：+${gained} 方块已到账`, 'ok');
        await load();
        return;
      }
      if (paying.tries >= 100) {
        stopPayPoll();
        if (shopPayText) shopPayText.textContent = '还没收到付款。支付页还开着就继续付，付完点「我已完成支付」。';
        return;
      }
      if (manual) BB.toast('还没收到付款，稍等一下再试一次', 'error');
    } catch (error) {
      if (manual) BB.toast(error.message || '查询订单失败，稍后再试', 'error');
    }
  }

  if (shopPayCheck) shopPayCheck.addEventListener('click', () => checkPay(true));
  if (shopPayCancel) {
    shopPayCancel.addEventListener('click', () => {
      // 只收面板，轮询照旧：用户可能收起来之后才付款，付完照样提示到账
      if (shopPay) shopPay.hidden = true;
      BB.toast('已收起，付完款方块会自动到账', 'ok');
    });
  }

  await load();
  await loadShop();

  // 从支付页跳回来（?pay=订单号）：直接确认这笔订单，付过的当场到账
  if (RETURN_PARAM) {
    paying = { outTradeNo: RETURN_PARAM, points: 0, timer: null, tries: 0 };
    if (shopPay) shopPay.hidden = false;
    if (shopPayTitle) shopPayTitle.textContent = '正在确认支付结果…';
    if (shopPayText) shopPayText.textContent = '稍等一下，确认到账后会自动刷新余额。';
    if (shopPayLink) shopPayLink.hidden = true;
    if (shopPayCheck) shopPayCheck.disabled = false;
    await checkPay(false);
    if (paying && !paying.timer) paying.timer = setInterval(checkPay, 3000);
  }
});
