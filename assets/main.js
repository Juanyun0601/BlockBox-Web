/* ============================================================
   方块盒子 BlockBox 官网 — 交互脚本
   ============================================================ */
(function () {
  "use strict";

  /* ---------- 年份 ---------- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- 导航滚动状态 ---------- */
  var nav = document.getElementById("nav");
  function onScroll() {
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 12);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- 移动端菜单 ---------- */
  var toggle = document.getElementById("navToggle");
  var links = document.getElementById("navLinks");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      toggle.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    links.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        links.classList.remove("open");
        toggle.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* ---------- 滚动入场动效 ---------- */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
  document.querySelectorAll(".reveal").forEach(function (el) { io.observe(el); });

  /* ---------- 数字计数 ---------- */
  var cio = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      cio.unobserve(e.target);
      var el = e.target, target = parseInt(el.getAttribute("data-count"), 10) || 0;
      var t0 = performance.now(), dur = 1400;
      (function tick(t) {
        var p = Math.min((t - t0) / dur, 1);
        p = 1 - Math.pow(1 - p, 3); /* easeOutCubic */
        el.textContent = Math.round(target * p);
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    });
  }, { threshold: 0.6 });
  document.querySelectorAll(".num[data-count]").forEach(function (el) { cio.observe(el); });

  /* ---------- 英雄立方体鼠标视差 ---------- */
  var heroVisual = document.getElementById("heroVisual");
  var cube = document.querySelector(".hero-cube");
  if (heroVisual && cube && window.matchMedia("(pointer:fine)").matches) {
    heroVisual.addEventListener("mousemove", function (ev) {
      var r = heroVisual.getBoundingClientRect();
      var dx = (ev.clientX - r.left) / r.width - 0.5;
      var dy = (ev.clientY - r.top) / r.height - 0.5;
      cube.style.transform = "rotateY(" + (dx * 16) + "deg) rotateX(" + (-dy * 14) + "deg)";
    });
    heroVisual.addEventListener("mouseleave", function () {
      cube.style.transform = "";
    });
  }

  /* ============================================================
     AI 聊天演示 — 打字机循环
     ============================================================ */
  var chatBody = document.getElementById("chatBody");
  if (chatBody) {
    var reduced = window.innerWidth < 760;
    var script = [
      {
        user: "游戏闪退了，日志在这儿 🙃",
        ai: "已读完日志，定位到 <code>java.lang.OutOfMemoryError: Java heap space</code>。\n\n「系统探索」实例默认内存只有 <b>1024MB</b>，建议调到 <b>4096MB</b>。要我直接改好吗？",
        chip: "✓ 已自动完成：内存调整 + 参数校验"
      },
      {
        user: "帮我找几个 1.20.1 的地图类 Mod",
        ai: "在 Modrinth 与 CurseForge 检索到 3 个高匹配结果，均已适配 <b>Fabric 1.20.1</b>：\n\n1. <b>Journeymap</b> — 小地图 + 路径标记\n2. <b>Xaero's Minimap</b> — 轻量流畅\n3. <b>Antique Atlas</b> — 复古地图册\n\n需要我把它们一键装进当前实例吗？",
        chip: "✓ 已读取你的实例：Fabric 1.20.1 · Forge 冲突已排除"
      }
    ];

    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    function makeMsg(cls) {
      var d = document.createElement("div");
      d.className = "msg " + cls;
      chatBody.appendChild(d);
      return d;
    }
    function makeTyping() {
      var d = document.createElement("div");
      d.className = "msg msg-ai typing";
      d.innerHTML = "<i></i><i></i><i></i>";
      chatBody.appendChild(d);
      return d;
    }
    function scrollChat() { chatBody.scrollTop = chatBody.scrollHeight; }
    function typeInto(el, html) {
      /* 按可见字符逐个显示；简单起见按标签切片：纯文本打字，标签一次性落位 */
      var plain = html.replace(/<[^>]+>/g, "");
      el.textContent = "";
      el.classList.add("caret-host");
      var caret = document.createElement("span");
      caret.className = "caret";
      el.appendChild(caret);
      var i = 0;
      return new Promise(function (resolve) {
        (function step() {
          if (i >= plain.length) { caret.remove(); el.innerHTML = html; resolve(); return; }
          caret.insertAdjacentText("beforebegin", plain.charAt(i++));
          scrollChat();
          setTimeout(step, 22 + Math.random() * 26);
        })();
      });
    }

    async function run() {
      for (var loop = 0; ; loop++) {
        var s = script[loop % script.length];
        chatBody.innerHTML = "";
        await sleep(500);
        var u = makeMsg("msg-user");
        u.textContent = s.user;
        scrollChat();
        await sleep(700);
        var t = makeTyping(); scrollChat();
        await sleep(reduced ? 600 : 1100);
        t.remove();
        var a = makeMsg("msg-ai");
        await typeInto(a, s.ai);
        await sleep(500);
        var c = document.createElement("div");
        c.className = "msg-chip reveal in";
        c.style.opacity = "0";
        c.style.transform = "translateY(8px)";
        c.style.transition = "all .5s ease";
        c.textContent = s.chip;
        chatBody.appendChild(c); scrollChat();
        await sleep(60);
        c.style.opacity = "1"; c.style.transform = "none";
        await sleep(4200);
      }
    }
    /* 减少动效偏好：静态展示一轮完整对话，避免窗口永远空白 */
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      var s0 = script[0];
      var su = makeMsg("msg-user"); su.textContent = s0.user;
      var sa = makeMsg("msg-ai"); sa.innerHTML = s0.ai;
      var sc = document.createElement("div");
      sc.className = "msg-chip";
      sc.textContent = s0.chip;
      chatBody.appendChild(sc);
    } else {
      run();
    }
  }

  /* ============================================================
     实例助手演示卡 — 纯 CSS 呈现，无脚本逻辑
     ============================================================ */

})();
