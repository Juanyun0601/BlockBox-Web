/* 官网明暗主题：<html data-theme="light|dark"> + localStorage(bb_site_theme)
   未手动选择时跟随系统 prefers-color-scheme。同步脚本，需放在 <head> 里尽早执行。 */
(function () {
  'use strict';

  var KEY = 'bb_site_theme';
  var root = document.documentElement;
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'dark' || v === 'light' ? v : null;
    } catch (e) {
      return null;
    }
  }

  function systemTheme() {
    return mql && mql.matches ? 'dark' : 'light';
  }

  function hasTheme() {
    var v = root.getAttribute('data-theme');
    return v === 'dark' || v === 'light' ? v : null;
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
  }

  function current() {
    return hasTheme() || systemTheme();
  }

  /* 尽早应用，避免首屏闪白；支持 ?theme=dark / ?theme=light 强制预览 */
  var forced = null;
  try {
    var m = /[?&]theme=(dark|light)\b/.exec(location.search);
    if (m) forced = m[1];
  } catch (e) {}
  var saved = stored();
  apply(forced || saved || hasTheme() || systemTheme());

  function isZh() {
    var lang = (document.documentElement.getAttribute('lang') || 'zh').toLowerCase();
    return lang.indexOf('zh') === 0;
  }

  function label(theme) {
    if (isZh()) return theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
    return theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }

  function syncLabel(btn) {
    var text = label(current());
    btn.setAttribute('aria-label', text);
    btn.setAttribute('title', text);
    btn.setAttribute('aria-pressed', current() === 'dark' ? 'true' : 'false');
  }

  function buildButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'themeSwitch';
    btn.className = 'theme-switch';
    btn.setAttribute('data-i18n-skip', '');
    btn.innerHTML =
      '<span class="theme-ic theme-ic-sun" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
          '<circle cx="12" cy="12" r="4.2"/>' +
          '<path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>' +
        '</svg>' +
      '</span>' +
      '<span class="theme-ic theme-ic-moon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.7 8.7 0 1 0 10.8 10.8Z"/>' +
        '</svg>' +
      '</span>';

    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      syncLabel(btn);
    });

    syncLabel(btn);
    return btn;
  }

  function mount() {
    var bar = document.querySelector('.nav-inner');
    if (!bar || bar.querySelector('.theme-switch')) return;
    var toggle = bar.querySelector('.nav-toggle');
    var btn = buildButton();
    /* 放在汉堡按钮前：窄屏菜单收起时也能直接切换 */
    if (toggle && toggle.parentNode === bar) bar.insertBefore(btn, toggle);
    else bar.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  /* 用户没手动选过时，跟随系统切换 */
  if (mql) {
    var onSystemChange = function () {
      if (!stored()) apply(systemTheme());
    };
    if (mql.addEventListener) mql.addEventListener('change', onSystemChange);
    else if (mql.addListener) mql.addListener(onSystemChange);
  }
})();
