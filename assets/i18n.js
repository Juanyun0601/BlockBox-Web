/* ============================================================
   方块盒子 BlockBox 官网 — 多语言运行时
   ------------------------------------------------------------
   用法：
     1. 在 <head> 里引入本文件（首页/下载页/文档页共用）；
     2. 文案字典放在 assets/i18n/<code>.js，按当前语言按需加载；
     3. 页面里不需要任何 data-* 标记：脚本会按「元素整句 HTML」
        和「纯文本节点」两种粒度去字典里查表替换。
   语言优先级：URL ?lang= → localStorage → <html lang> → 简体中文
   ============================================================ */
(function () {
  "use strict";

  var LANGS = [
    { code: "zh-CN", label: "简体中文", htmlLang: "zh-CN" },
    { code: "zh-TW", label: "繁體中文", htmlLang: "zh-Hant" },
    { code: "en",    label: "English",  htmlLang: "en" },
    { code: "es",    label: "Español",  htmlLang: "es" },
    { code: "ja",    label: "日本語",    htmlLang: "ja" },
    { code: "ru",    label: "Русский",  htmlLang: "ru" }
  ];
  var STORE_KEY = "bb_site_lang";
  var DEFAULT_LANG = "zh-CN";
  var SKIP_TAGS = { script: 1, style: 1, svg: 1, pre: 1, code: 1, kbd: 1, samp: 1, var: 1, textarea: 1 };
  var ATTRS = ["placeholder", "title", "aria-label", "alt"];
  var CJK = /[\u4e00-\u9fff]/;
  var WS = /\s+/g;

  /* ---------------- 语言判定 ---------------- */

  function known(code) {
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i].code.toLowerCase() === String(code).toLowerCase()) return LANGS[i].code;
    }
    return null;
  }

  function langFromQuery() {
    try {
      var q = new URLSearchParams(window.location.search).get("lang");
      if (!q) return null;
      var c = known(q);
      if (c) return c;
      // 支持 lang=en-US、lang=zh-Hant 这类写法
      var base = q.split("-")[0].toLowerCase();
      if (base === "zh") return /hant|tw|hk/i.test(q) ? "zh-TW" : "zh-CN";
      var hit = known(base);
      return hit;
    } catch (e) {
      return null;
    }
  }

  function detectLang() {
    var fromQuery = langFromQuery();
    if (fromQuery) {
      /* 通过 ?lang= 分享进来时记住选择，站内跳转不会掉回中文 */
      try { localStorage.setItem(STORE_KEY, fromQuery); } catch (e) { /* ignore */ }
      return fromQuery;
    }
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved && known(saved)) return known(saved);
    } catch (e) { /* 隐私模式下忽略 */ }
    var docLang = document.documentElement.getAttribute("lang");
    if (docLang) {
      var base = docLang.split("-")[0].toLowerCase();
      if (base === "zh") return /hant|tw|hk/i.test(docLang) ? "zh-TW" : "zh-CN";
      var hit = known(base);
      if (hit) return hit;
    }
    return DEFAULT_LANG;
  }

  var currentLang = detectLang();
  var dict = null;

  /* ---------------- 字典加载 ----------------
     在 <head> 里解析时用 document.write 同步插入，避免页面先闪一下中文。
     插入的脚本会在本脚本返回后、body 解析前执行，所以正文脚本（main.js）
     只要经过 BB.t() 就能直接读到 window.BB_I18N_DICT。 */

  function dictPath(code) {
    return "assets/i18n/" + code + ".js";
  }

  function loadDict(code) {
    if (code === DEFAULT_LANG) return;
    if (document.readyState === "loading") {
      document.write('<script src="' + dictPath(code) + '"><\/script>');
      return;
    }
    var s = document.createElement("script");
    s.src = dictPath(code);
    document.head.appendChild(s);
  }

  function getDict() {
    if (!dict) dict = window.BB_I18N_DICT || null;
    return dict;
  }

  /* ---------------- 查表替换 ---------------- */

  function norm(s) {
    return (s || "").replace(WS, " ").trim();
  }

  /** 元素整句的 key：去掉注释后的 innerHTML，再归一化空白 */
  function unitKey(el) {
    var clone = el.cloneNode(true);
    stripComments(clone);
    return norm(clone.innerHTML);
  }

  function stripComments(node) {
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_COMMENT, null);
    var list = [];
    while (walker.nextNode()) list.push(walker.currentNode);
    for (var i = 0; i < list.length; i++) {
      if (list[i].parentNode) list[i].parentNode.removeChild(list[i]);
    }
  }

  function lookup(key) {
    var d = getDict();
    if (!d || !key) return null;
    return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : null;
  }

  function translateAttributes(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var v = el.getAttribute(a);
      if (!v || !CJK.test(v)) continue;
      var t = lookup(norm(v));
      if (t !== null && t !== v) el.setAttribute(a, t);
    }
    if (el.tagName && el.tagName.toLowerCase() === "meta") {
      var c = el.getAttribute("content");
      if (c && CJK.test(c)) {
        var tc = lookup(norm(c));
        if (tc !== null && tc !== c) el.setAttribute("content", tc);
      }
    }
  }

  function translateChildren(node) {
    var child = node.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 3) {
        var raw = child.nodeValue;
        if (CJK.test(raw)) {
          var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
          var lead = m ? m[1] : "";
          var core = m ? m[2] : raw;
          var trail = m ? m[3] : "";
          var hit = lookup(norm(core));
          if (hit !== null && hit !== core) {
            child.nodeValue = lead + hit + trail;
          }
        }
      } else if (child.nodeType === 1) {
        var tag = child.tagName ? child.tagName.toLowerCase() : "";
        if (SKIP_TAGS[tag] || child.hasAttribute("data-i18n-skip")) {
          child = next;
          continue;
        }
        translateAttributes(child);
        if (child.children && child.children.length) {
          var key = unitKey(child);
          var val = lookup(key);
          if (val !== null && val !== child.innerHTML) {
            child.innerHTML = val;
            child = next;
            continue;
          }
        }
        translateChildren(child);
      }
      child = next;
    }
  }

  var applyRetry = false;
  var observerStarted = false;
  var observerPending = false;

  /** 页面里由脚本动态插入的文案（下载页系统识别、AI 演示对话等）也要补翻 */
  function startObserver() {
    if (observerStarted || !window.MutationObserver) return;
    observerStarted = true;
    var mo = new MutationObserver(function (muts) {
      var relevant = false;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "characterData") { relevant = true; break; }
        if (m.type === "childList" && (m.addedNodes.length || m.removedNodes.length)) { relevant = true; break; }
      }
      if (!relevant || observerPending) return;
      observerPending = true;
      setTimeout(function () {
        observerPending = false;
        if (document.body) translateChildren(document.body);
      }, 40);
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function apply() {
    var root = document.body;
    if (!root) return;
    setupSwitcher();
    if (currentLang === DEFAULT_LANG) return;
    if (!getDict()) {
      /* 字典还没就绪（脚本被延迟执行时会发生）：等它加载完再补一次 */
      if (applyRetry) return;
      applyRetry = true;
      var s = document.createElement("script");
      s.src = dictPath(currentLang);
      s.onload = function () { applyRetry = false; apply(); };
      s.onerror = function () { applyRetry = false; };
      document.head.appendChild(s);
      return;
    }
    translateAttributes(document.documentElement);
    var title = document.querySelector("title");
    if (title && title.textContent) {
      var t = lookup(norm(title.textContent));
      if (t !== null) title.textContent = t;
    }
    var metas = document.querySelectorAll('meta[name="description"], meta[property^="og:"]');
    for (var i = 0; i < metas.length; i++) translateAttributes(metas[i]);
    translateChildren(root);
    startObserver();
  }

  /* ---------------- 语言切换器 ---------------- */

  function setupSwitcher() {
    var host = document.getElementById("navLinks");
    if (!host || document.getElementById("langSwitch")) return;
    var wrap = document.createElement("label");
    wrap.className = "lang-switch";
    wrap.id = "langSwitch";
    wrap.setAttribute("data-i18n-skip", "");
    wrap.setAttribute("title", "Language");
    var globe = document.createElement("span");
    globe.className = "lang-ic";
    globe.setAttribute("aria-hidden", "true");
    globe.textContent = "Aあ";
    var sel = document.createElement("select");
    sel.setAttribute("aria-label", "Language");
    for (var i = 0; i < LANGS.length; i++) {
      var o = document.createElement("option");
      o.value = LANGS[i].code;
      o.textContent = LANGS[i].label;
      if (LANGS[i].code === currentLang) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", function () {
      setLang(sel.value);
    });
    wrap.appendChild(globe);
    wrap.appendChild(sel);
    host.insertBefore(wrap, host.firstChild);
    // 移动端菜单：选完就收起
    sel.addEventListener("change", function () {
      host.classList.remove("open");
      var tg = document.getElementById("navToggle");
      if (tg) { tg.classList.remove("open"); tg.setAttribute("aria-expanded", "false"); }
    });
  }

  function setLang(code) {
    code = known(code) || DEFAULT_LANG;
    try { localStorage.setItem(STORE_KEY, code); } catch (e) { /* ignore */ }
    var url = new URL(window.location.href);
    if (code === DEFAULT_LANG) url.searchParams.delete("lang");
    else url.searchParams.set("lang", code);
    window.location.replace(url.toString());
  }

  /* ---------------- 对外接口 ---------------- */

  function metaOf(code) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === code) return LANGS[i];
    return LANGS[0];
  }

  window.BB = {
    lang: function () { return currentLang; },
    t: function (s) {
      var v = lookup(norm(s));
      return v === null ? s : v;
    },
    setLang: setLang,
    languages: LANGS
  };

  var htmlLang = metaOf(currentLang).htmlLang;
  document.documentElement.setAttribute("lang", htmlLang);

  loadDict(currentLang);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
})();
