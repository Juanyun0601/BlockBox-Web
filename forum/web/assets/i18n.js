/* ============================================================
   方块盒子论坛 — 多语言运行时
   ------------------------------------------------------------
   用法：
     1. 在每个页面 <head> 里、样式表之前引入本文件；
     2. 文案字典放在 /assets/i18n/<code>.js，按当前语言按需加载；
     3. 页面不需要 data-* 标记：脚本按「纯文本节点」和
        placeholder / title / aria-label / alt 两种粒度查表替换；
     4. 由脚本动态渲染出来的内容由 MutationObserver 自动补翻。
   语言优先级：URL ?lang= → localStorage → <html lang> → 简体中文
   占位符：字典键里的 {n} 会按原文中的数字依次还原，例如
       键「{n} 分钟前」→ 原文「5 分钟前」→ 译文「5 minutes ago」。
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
  var STORE_KEY = "bbf-lang";
  var DEFAULT_LANG = "zh-CN";
  var DICT_VER = "20261119a";
  var SKIP_TAGS = { script: 1, style: 1, svg: 1, pre: 1, code: 1, kbd: 1, samp: 1, textarea: 1 };
  var ATTRS = ["placeholder", "title", "aria-label", "alt"];
  var SKIP_SELECTOR = [
    "[data-i18n-skip]",
    ".post-content", ".child-content", ".md-body", ".md-preview",
    ".editor-preview", ".code-block", ".cm-editor"
  ].join(",");
  var CJK = /[\u4e00-\u9fff]/;
  var WS = /\s+/g;

  /* ---------------- 语言判定 ---------------- */

  function known(code) {
    if (!code) return null;
    code = String(code);
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i].code.toLowerCase() === code.toLowerCase()) return LANGS[i].code;
    }
    return null;
  }

  function fromTag(tag) {
    var raw = String(tag || "");
    var base = raw.split("-")[0].toLowerCase();
    if (base === "zh") return /hant|tw|hk|mo/i.test(raw) ? "zh-TW" : "zh-CN";
    return known(base);
  }

  function detectLang() {
    try {
      var q = new URLSearchParams(window.location.search).get("lang");
      if (q) {
        var c = fromTag(q);
        if (c) {
          try { localStorage.setItem(STORE_KEY, c); } catch (e) { /* ignore */ }
          return c;
        }
      }
    } catch (e) { /* ignore */ }
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved && known(saved)) return known(saved);
    } catch (e) { /* 隐私模式忽略 */ }
    return fromTag(document.documentElement.getAttribute("lang")) || DEFAULT_LANG;
  }

  var currentLang = detectLang();
  var dict = null;

  /* ---------------- 字典加载 ----------------
     在 <head> 里解析时用 document.write 同步插入，避免页面先闪一下中文。 */

  function dictPath(code) {
    return "/assets/i18n/" + code + ".js?v=" + DICT_VER;
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
    if (!dict) dict = window.BBF_I18N_DICT || null;
    return dict;
  }

  /* ---------------- 查表替换 ---------------- */

  function norm(s) {
    return String(s == null ? "" : s).replace(WS, " ").trim();
  }

  /** 把数字统一换成 {n}，两边用同一套写法才能对上 */
  function keyOf(s) {
    return norm(s).replace(/\d+/g, "{n}");
  }

  function lookup(text) {
    var d = getDict();
    if (!d || !text) return null;
    if (Object.prototype.hasOwnProperty.call(d, text)) return d[text];
    var k = keyOf(text);
    if (k === text) return null;
    return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null;
  }

  /** 译文里的 {n} 按原文数字顺序还原 */
  function fillNumbers(tpl, text) {
    var nums = text.match(/\d+/g) || [];
    var need = (tpl.match(/\{n\}/g) || []).length;
    if (need !== nums.length) return null;
    var i = 0;
    return tpl.replace(/\{n\}/g, function () { return nums[i++]; });
  }

  function translate(text) {
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    var lead = m ? m[1] : "";
    var core = m ? m[2] : text;
    var trail = m ? m[3] : "";
    if (!CJK.test(core)) return null;
    var hit = lookup(core);
    if (hit == null) return null;
    if (hit.indexOf("{n}") >= 0) {
      var filled = fillNumbers(hit, core);
      if (filled == null) return null;
      hit = filled;
    }
    if (hit === core) return null;
    return lead + hit + trail;
  }

  function isSkipped(el) {
    if (!el || !el.closest) return false;
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (SKIP_TAGS[tag]) return true;
    return !!el.closest(SKIP_SELECTOR);
  }

  function translateAttributes(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      var v = el.getAttribute(a);
      if (!v || !CJK.test(v)) continue;
      var t = translate(v);
      if (t !== null) el.setAttribute(a, t);
    }
  }

  function translateChildren(node) {
    var child = node.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 3) {
        if (CJK.test(child.nodeValue)) {
          var t = translate(child.nodeValue);
          if (t !== null) child.nodeValue = t;
        }
      } else if (child.nodeType === 1) {
        if (!isSkipped(child)) {
          translateAttributes(child);
          translateChildren(child);
        }
      }
      child = next;
    }
  }

  var observerPending = false;
  var observerStarted = false;

  function startObserver() {
    if (observerStarted || !window.MutationObserver || !document.body) return;
    observerStarted = true;
    var mo = new MutationObserver(function (muts) {
      if (observerPending) return;
      var relevant = false;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "childList" && (m.addedNodes.length || m.removedNodes.length)) { relevant = true; break; }
        if (m.type === "characterData") { relevant = true; break; }
      }
      if (!relevant) return;
      observerPending = true;
      setTimeout(function () {
        observerPending = false;
        if (currentLang !== DEFAULT_LANG && getDict()) {
          translateChildren(document.body);
          translateTitle();
        }
        ensureSwitcher();
      }, 60);
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function translateTitle() {
    var title = document.querySelector("title");
    if (!title || !title.textContent) return;
    var t = translate(title.textContent);
    if (t !== null) {
      title.textContent = t;
      return;
    }
    /* 帖子标题 / 用户名 / 板块名 + 「 · 方块盒子论坛」这类动态标题：只翻后缀 */
    var m = /^([\s\S]*?)\s·\s方块盒子论坛$/.exec(title.textContent);
    if (m) {
      var prefix = translate(m[1]);
      var suffix = lookup("方块盒子论坛") || "方块盒子论坛";
      title.textContent = (prefix === null ? m[1] : prefix) + " · " + suffix;
    }
  }

  function translateHead() {
    translateTitle();
    var metas = document.querySelectorAll('meta[name="description"], meta[property^="og:"]');
    for (var i = 0; i < metas.length; i++) translateAttributes(metas[i]);
  }

  /* ---------------- 语言切换器 ---------------- */

  function ensureSwitcher() {
    var host = document.querySelector(".nav-actions");
    if (!host) return;
    if (document.getElementById("langSwitch")) return;
    var wrap = document.createElement("label");
    wrap.className = "lang-switch";
    wrap.id = "langSwitch";
    wrap.setAttribute("data-i18n-skip", "");
    wrap.setAttribute("title", "Language / 语言");
    var sel = document.createElement("select");
    sel.setAttribute("aria-label", "Language");
    for (var i = 0; i < LANGS.length; i++) {
      var o = document.createElement("option");
      o.value = LANGS[i].code;
      o.textContent = LANGS[i].label;
      if (LANGS[i].code === currentLang) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", function () { setLang(sel.value); });
    wrap.appendChild(sel);
    var theme = host.querySelector("#themeToggle");
    if (theme && theme.parentNode === host) host.insertBefore(wrap, theme);
    else host.insertBefore(wrap, host.firstChild);
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

  window.BBF = {
    lang: function () { return currentLang; },
    t: function (s) {
      var t = translate(s);
      return t === null ? s : t;
    },
    /** 带位置参数的模板翻译：BBF.tf('搜索：{0} · 方块盒子论坛', query) */
    tf: function (tpl) {
      var t = translate(tpl);
      var out = t === null ? tpl : t;
      for (var i = 1; i < arguments.length; i++) {
        out = out.split("{" + (i - 1) + "}").join(String(arguments[i]));
      }
      return out;
    },
    setLang: setLang,
    languages: LANGS
  };

  document.documentElement.setAttribute("lang", metaOf(currentLang).htmlLang);

  loadDict(currentLang);

  function apply() {
    if (!document.body) return;
    if (currentLang !== DEFAULT_LANG) {
      if (!getDict()) {
        /* 字典被延迟加载时，等它到了再扫一遍 */
        setTimeout(apply, 120);
        return;
      }
      translateHead();
      translateChildren(document.body);
    }
    ensureSwitcher();
    startObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
})();
