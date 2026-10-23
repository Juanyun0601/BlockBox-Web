/* ============================================================
   方块盒子官网 — 开发文档页脚本
   顶部导航的滚动状态与移动端菜单与首页（assets/main.js）保持一致
   ============================================================ */
(function () {
    'use strict';

    /* ---------- 导航滚动状态 ---------- */
    var nav = document.getElementById('nav');
    function onScroll() {
        if (nav) nav.classList.toggle('scrolled', window.scrollY > 12);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    /* ---------- 移动端菜单 ---------- */
    var toggle = document.getElementById('navToggle');
    var links = document.getElementById('navLinks');
    if (toggle && links) {
        toggle.addEventListener('click', function () {
            var open = links.classList.toggle('open');
            toggle.classList.toggle('open', open);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        links.querySelectorAll('a').forEach(function (a) {
            a.addEventListener('click', function () {
                links.classList.remove('open');
                toggle.classList.remove('open');
                toggle.setAttribute('aria-expanded', 'false');
            });
        });
    }
})();
