// 人机验证页：拖动滑块把拼图拖到缺口上。
// 这一页不用 core.js 的 boot（它一上来就请求 /api/me，没过验证会被踢回本页），
// 只调 /api/human/* 这几个放行的接口。
(function () {
  const $ = (id) => document.getElementById(id);
  const card = $('hcCard');
  const loading = $('hcLoading');
  const body = $('hcBody');
  const stage = $('hcStage');
  const bgImg = $('hcBg');
  const pieceImg = $('hcPiece');
  const track = $('hcTrack');
  const fill = $('hcFill');
  const handle = $('hcHandle');
  const text = $('hcText');
  const hint = $('hcHint');

  // 只接受站内相对路径，避免验证完被送去站外
  const rawNext = new URLSearchParams(location.search).get('next') || '/';
  const next =
    rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/verify.html')
      ? rawNext
      : '/';

  let challenge = null;
  let scale = 1;
  let drag = 0; // 拼图左边相对画布左边的距离（画布像素）
  let state = 'loading'; // loading | idle | dragging | checking | done
  let startPointer = 0;
  let startDrag = 0;
  let startedAt = 0;

  const maxDrag = () => (challenge ? challenge.width - challenge.piece.size : 1);

  function layout() {
    if (!challenge) return;
    scale = stage.clientWidth / challenge.width || 1;
    const size = challenge.piece.w * scale;
    pieceImg.style.width = `${size}px`;
    pieceImg.style.height = `${size}px`;
    pieceImg.style.top = `${challenge.piece.top * scale}px`;
    applyDrag();
  }

  function applyDrag() {
    if (!challenge) return;
    const maxHandle = Math.max(1, track.clientWidth - handle.offsetWidth);
    const ratio = Math.max(0, Math.min(1, drag / maxDrag()));
    handle.style.transform = `translateX(${ratio * maxHandle}px)`;
    fill.style.width = `${handle.offsetWidth + ratio * maxHandle}px`;
    pieceImg.style.transform = `translateX(${(drag - challenge.piece.pad) * scale}px)`;
    handle.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  function setDrag(value) {
    drag = Math.max(0, Math.min(maxDrag(), value));
    applyDrag();
  }

  function setHint(message) {
    hint.textContent = message || '';
  }

  async function loadChallenge() {
    state = 'loading';
    track.classList.remove('is-ok', 'is-bad', 'is-dragging');
    text.textContent = '向右拖动滑块';
    loading.hidden = false;
    body.hidden = true;

    try {
      const res = await fetch('/api/human/challenge', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.id) {
        throw new Error((data && data.error) || '验证题没取到，稍后再试');
      }
      challenge = data;
      drag = 0;
      bgImg.src = data.bg;
      pieceImg.src = data.piece_img;
      loading.hidden = true;
      body.hidden = false;
      state = 'idle';
      layout();
      setHint(`拖动滑块把拼图对准缺口，通过后 ${ttlText()}内不再询问`);
    } catch (error) {
      loading.hidden = true;
      body.hidden = true;
      setHint(error.message || '网络不太好，请刷新页面重试');
    }
  }

  function ttlText() {
    const hours = Number(challenge && challenge.ttl_hours) || 0;
    if (hours >= 1) return `${Math.round(hours)} 小时`;
    return `${Math.max(1, Math.round(hours * 60))} 分钟`;
  }

  async function submit() {
    if (!challenge || state !== 'idle') return;
    state = 'checking';
    const duration = Math.round(performance.now() - startedAt);

    try {
      const res = await fetch('/api/human/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id: challenge.id, answer: Math.round(drag), duration }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '验证没通过，再试一次');

      state = 'done';
      track.classList.add('is-ok');
      text.textContent = '验证通过，正在进入…';
      setHint('');
      setTimeout(() => location.replace(next), 260);
    } catch (error) {
      state = 'idle';
      track.classList.add('is-bad');
      text.textContent = '没对准，换一张再来';
      setHint(error.message || '验证没通过，再试一次');
      setTimeout(() => {
        if (state === 'idle') loadChallenge();
      }, 900);
    }
  }

  function finish() {
    track.classList.remove('is-dragging');
    if (state !== 'dragging') return;
    state = 'idle';
    if (drag < 4) {
      setDrag(0);
      return;
    }
    submit();
  }

  // ── 拖动 ──
  track.addEventListener('pointerdown', (event) => {
    if (state !== 'idle' || event.button > 0) return;
    state = 'dragging';
    startPointer = event.clientX;
    startDrag = drag;
    startedAt = performance.now();
    track.classList.add('is-dragging');
    track.classList.remove('is-bad');
    setHint('');
    if (handle.setPointerCapture) {
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* 老浏览器忽略 */
      }
    }
    event.preventDefault();
  });

  track.addEventListener('pointermove', (event) => {
    if (state !== 'dragging') return;
    setDrag(startDrag + (event.clientX - startPointer) / scale);
  });

  track.addEventListener('pointerup', finish);
  track.addEventListener('pointercancel', () => {
    if (state === 'dragging') {
      state = 'idle';
      track.classList.remove('is-dragging');
      setDrag(0);
    }
  });

  // ── 键盘：左右微调，回车提交 ──
  handle.addEventListener('keydown', (event) => {
    if (state !== 'idle') return;
    const step = event.shiftKey ? 12 : 4;
    if (event.key === 'ArrowLeft') {
      setDrag(drag - step);
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      setDrag(drag + step);
      event.preventDefault();
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (drag >= 4) {
        startedAt = performance.now();
        submit();
      }
      event.preventDefault();
    }
  });

  window.addEventListener('resize', layout);

  // ── 开始 ──
  (async function start() {
    try {
      const res = await fetch('/api/human/status', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (data && (data.verified || data.enabled === false)) {
        location.replace(next);
        return;
      }
    } catch {
      /* 查不到状态就直接做验证 */
    }
    loadChallenge();
  })();
})();
