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
     AI 聊天演示 — 打字机循环（对齐客户端 AiChatPage 排版：
     无气泡整行消息 + 引用标签 + 模组推荐卡 + 回答操作条）
     ============================================================ */
  var chatBody = document.getElementById("chatBody");
  if (chatBody) {
    var reduced = window.innerWidth < 760;
    var script = [
      {
        user: "游戏闪退了，日志在这儿 🙃",
        time: "14:32",
        refs: ["📎 latest.log", "📎 实例: 系统探索"],
        ai: "已读完崩溃日志，定位到 <code>java.lang.OutOfMemoryError: Java heap space</code>。\n\n「系统探索」实例默认内存只有 <b>1024MB</b>，建议调到 <b>4096MB</b>。要我直接改好吗？",
        agent: "✓ 已自动完成：内存调整 + 参数校验",
        meta: "14:32 · Agent · 3 次工具调用"
      },
      {
        user: "帮我推荐几个 1.20.1 Fabric 的性能优化 Mod",
        time: "14:35",
        refs: ["📎 实例: 1.20.1-Fabric"],
        ai: "针对 <b>1.20.1 · Fabric</b>，下面是兼顾帧率与内存的经典组合，已按你的实例完成版本匹配：",
        mods: [
          ["S", "linear-gradient(135deg, #43a047, #1b5e20)", "Sodium", "渲染管线重写 · 帧率提升 40%+"],
          ["L", "linear-gradient(135deg, #5c6bc0, #3949ab)", "Lithium", "游戏逻辑优化 · 明显减少卡顿"],
          ["F", "linear-gradient(135deg, #fb8c00, #e65100)", "FerriteCore", "内存占用优化 · 降低 25% 左右"]
        ],
        ai2: "三者组合约可提升 <b>50% 帧率</b> 并降低 <b>30% 内存占用</b>。需要我一键装进当前实例吗？",
        agent: null,
        meta: "14:35 · Agent · 搜索资源 × 2"
      }
    ];

    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    function make(cls) {
      var d = document.createElement("div");
      d.className = cls;
      chatBody.appendChild(d);
      return d;
    }
    function scrollChat() { chatBody.scrollTop = chatBody.scrollHeight; }

    /* 构建一条完整回答（refs + 若干段落 + 模组卡 + 操作条） */
    function buildAnswer(s, instant) {
      var box = make("cm-ai");
      if (s.refs && s.refs.length) {
        var refs = document.createElement("div");
        refs.className = "cm-refs";
        s.refs.forEach(function (t) {
          var r = document.createElement("span");
          r.className = "cm-ref";
          r.textContent = t;
          refs.appendChild(r);
        });
        box.appendChild(refs);
      }
      var p1 = document.createElement("p");
      p1.className = "cm-text";
      box.appendChild(p1);
      if (instant) { p1.innerHTML = s.ai; }

      if (s.mods) {
        s.mods.forEach(function (m, idx) {
          var mod = document.createElement("div");
          mod.className = "cm-mod";
          if (instant) { mod.style.animation = "none"; }
          var ic = document.createElement("i");
          ic.className = "m-ic";
          ic.style.background = m[1];
          ic.textContent = m[0];
          var info = document.createElement("div");
          info.className = "m-info";
          info.innerHTML = "<b></b><span></span>";
          info.firstChild.textContent = m[2];
          info.lastChild.textContent = m[3];
          var btn = document.createElement("em");
          btn.className = "m-btn";
          btn.textContent = "下载";
          mod.appendChild(ic); mod.appendChild(info); mod.appendChild(btn);
          box.appendChild(mod);
          if (!instant) { mod.style.animationDelay = (0.15 + idx * 0.35) + "s"; }
        });
      }

      var p2 = null;
      if (s.ai2) {
        p2 = document.createElement("p");
        p2.className = "cm-text";
        box.appendChild(p2);
        if (instant) { p2.innerHTML = s.ai2; }
      }

      var tools = document.createElement("div");
      tools.className = "cm-tools";
      ["👍 赞同", "⧉ 复制", "↻ 重新生成"].forEach(function (t) {
        var sp = document.createElement("span");
        sp.textContent = t;
        tools.appendChild(sp);
      });
      var meta = document.createElement("div");
      meta.className = "cm-meta";
      meta.textContent = s.meta;
      if (instant) {
        box.appendChild(tools);
        box.appendChild(meta);
      }
      return { box: box, p1: p1, p2: p2, tools: tools, meta: meta };
    }

    function typeInto(el, html) {
      /* 纯文本打字，结束后落位完整 HTML */
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
          setTimeout(step, 16 + Math.random() * 20);
        })();
      });
    }

    function buildUser(s) {
      var u = make("cm-user");
      u.textContent = s.user;
      var t = document.createElement("em");
      t.textContent = s.time;
      u.appendChild(t);
      scrollChat();
    }

    async function run() {
      for (var loop = 0; ; loop++) {
        var s = script[loop % script.length];
        chatBody.innerHTML = "";
        await sleep(450);
        buildUser(s);
        await sleep(650);
        var t = make("cm-typing");
        t.innerHTML = "<i></i><i></i><i></i>";
        scrollChat();
        await sleep(reduced ? 550 : 950);
        t.remove();
        var a = buildAnswer(s, false);
        scrollChat();
        await typeInto(a.p1, s.ai);
        if (s.mods) await sleep(s.mods.length * 350 + 300);
        if (a.p2) { await typeInto(a.p2, s.ai2); }
        a.box.appendChild(a.tools);
        a.box.appendChild(a.meta);
        scrollChat();
        if (s.agent) {
          await sleep(450);
          var ag = make("cm-agent");
          ag.textContent = s.agent;
          scrollChat();
        }
        await sleep(4200);
      }
    }
    /* 演示动画始终播放（内容性动画，不随系统减少动效偏好走静态） */
    run();
  }

  /* ============================================================
     实例助手演示 — 当前时间 / 游玩时间 / 帧率 + 性能监控曲线
     （按客户端 InstanceHomePage 每秒刷新、2 秒采样的节奏）
     ============================================================ */
  (function () {
    var timeEl = document.querySelector(".ainfo-time b");
    var playEl = document.querySelector(".ainfo-play b");
    var fpsEl = document.querySelector(".ainfo-fps b");
    var cards = [
      { root: document.querySelector(".aperf-cpu"), data: [23, 26, 22, 30, 27, 35, 31, 24, 28, 25, 23, 23] },
      { root: document.querySelector(".aperf-mem"), data: [46, 48, 45, 52, 49, 55, 51, 47, 50, 46, 48, 46] },
      { root: document.querySelector(".aperf-gpu"), data: [31, 35, 28, 42, 38, 47, 41, 33, 36, 30, 34, 31] }
    ];
    if (!cards[0].root) return;

    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    function fmtPlay(sec) {
      var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return h + ":" + pad(m) + ":" + pad(s);
    }

    function renderCard(card) {
      if (!card.root) return;
      var v = card.data[card.data.length - 1];
      var head = card.root.querySelector(".ap-val");
      var bar = card.root.querySelector(".ap-track i");
      var line = card.root.querySelector(".ap-line");
      var fill = card.root.querySelector(".ap-fill");
      var dots = card.root.querySelector(".ap-dots");
      if (head) head.textContent = v + "%";
      if (bar) bar.style.width = v + "%";
      if (!line || !fill) return;
      var n = card.data.length;
      var pts = [];
      for (var i = 0; i < n; i++) {
        var x = (2 + i * (116 / (n - 1))).toFixed(1);
        var y = (34 - card.data[i] * 0.32).toFixed(1);
        pts.push(x + "," + y);
      }
      line.setAttribute("points", pts.join(" "));
      fill.setAttribute("d", "M2,34 L" + pts.join(" L") + " L118,34 Z");
      if (dots) {
        var svg = "";
        for (var j = 0; j < n; j++) {
          var xy = pts[j].split(",");
          svg += '<circle cx="' + xy[0] + '" cy="' + xy[1] + '" r="1.7"/>';
        }
        dots.innerHTML = svg;
      }
    }

    /* 首次渲染（含数据点圆点） */
    cards.forEach(renderCard);

    /* ---- 标签页轮播：首页 → AI 助手 → 快捷指令 → 联机 → 资源管理 ----
       下划线滑动对应客户端 switchToTab 的高亮位移动画 */
    var pagesWrap = document.getElementById("assistPages");
    var tabsBox = document.getElementById("assistTabs");
    if (pagesWrap && tabsBox) {
      var pages = Array.prototype.slice.call(pagesWrap.querySelectorAll(".apage"));
      var tabs = Array.prototype.slice.call(tabsBox.querySelectorAll(".atab[data-page]"));
      var line = tabsBox.querySelector(".atab-line");
      var order = ["home", "ai", "cmd", "mp", "res"];
      var pageIdx = 0;

      function positionLine(tab) {
        if (!tab || !line) return;
        line.style.left = (tab.offsetLeft + 7) + "px";
        line.style.width = Math.max(18, tab.offsetWidth - 14) + "px";
      }
      function applyPage(name) {
        tabs.forEach(function (t) { t.classList.toggle("on", t.dataset.page === name); });
        pages.forEach(function (p) { p.classList.toggle("on", p.dataset.page === name); });
        positionLine(tabsBox.querySelector('.atab[data-page="' + name + '"]'));
      }
      function sizePages() {
        var h = 0;
        pages.forEach(function (p) { h = Math.max(h, p.scrollHeight); });
        if (h > 0) pagesWrap.style.height = h + "px";
      }
      applyPage("home");
      sizePages();
      window.addEventListener("resize", function () {
        sizePages();
        positionLine(tabsBox.querySelector(".atab.on"));
      });
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(sizePages);

      var cycleTimer = null;
      var stopCycle = function () {
        if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
      };
      var startCycle = function () {
        stopCycle();
        cycleTimer = setInterval(function () {
          if (document.hidden) return; /* 页面在后台时跳过，回前台立即切换 */
          pageIdx = (pageIdx + 1) % order.length;
          applyPage(order[pageIdx]);
        }, 3000);
      };
      var scene = document.querySelector(".assist-scene");
      if (scene) {
        scene.addEventListener("mouseenter", stopCycle);
        scene.addEventListener("mouseleave", startCycle);
      }
      /* 从后台标签页回到前台时重启轮播，避免被浏览器限流后长时间停留 */
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) startCycle();
      });
      startCycle();
    }

    /* 时间每秒走字，性能曲线每 2 秒采样一次（模拟 HardwareMonitor 节奏） */
    var playSec = 42 * 60 + 17;
    setInterval(function () {
      if (timeEl) timeEl.textContent = new Date().toTimeString().slice(0, 8);
      if (playEl) { playSec += 1; playEl.textContent = fmtPlay(playSec); }
    }, 1000);

    setInterval(function () {
      cards.forEach(function (card) {
        var prev = card.data[card.data.length - 1];
        var next = Math.max(5, Math.min(95, prev + Math.round(Math.random() * 14 - 7)));
        card.data.push(next);
        card.data.shift();
        renderCard(card);
      });
      if (fpsEl) fpsEl.textContent = 110 + Math.floor(Math.random() * 18);
    }, 2000);
  })();

})();
