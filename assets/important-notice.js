/* ============================================================
   方块盒子官网 — 重要公告
   ------------------------------------------------------------
   论坛管理后台发布「启动重要公告」后会写进官网根目录的 announcement.json
   （和启动器首页公告是同一个文件，这里只读 important 字段）。
   打开首页、下载页、更新日志页、文档页时弹一次，正文支持简单 Markdown；
   关掉后按公告 id 记住，同一条不再打扰，后台换新公告会重新弹。

   拉不到文件、没发布公告时静默跳过，不影响正常浏览。
   ============================================================ */
(function () {
  "use strict";

  var STORE_KEY = "bb_important_dismissed";

  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* 官网有多语言运行时：界面文字先过一遍 BB.t()，没配译文时原样返回中文 */
  function t(text) {
    return window.BB && typeof window.BB.t === "function" ? window.BB.t(text) : text;
  }

  /* 链接只认 http(s) 和站内相对路径，公告文件被写坏也不会带出怪协议 */
  function safeUrl(url) {
    return /^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url);
  }

  /* ---------------- 简易 Markdown（先转义再加格式，不执行任何 HTML） ---------------- */

  function inline(raw) {
    var text = esc(raw);
    var codes = [];

    text = text.replace(/`([^`\n]+)`/g, function (match, code) {
      codes.push(code);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (match, alt, url) {
      if (!safeUrl(url)) return match;
      return '<img src="' + url + '" alt="' + alt + '" loading="lazy">';
    });
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (match, label, url) {
      if (!safeUrl(url)) return match;
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
    });
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<"']+)/g, function (match, prefix, url) {
      return prefix + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
    });
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    text = text.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return text.replace(/\u0000(\d+)\u0000/g, function (match, index) {
      return "<code>" + codes[Number(index)] + "</code>";
    });
  }

  function renderMarkdown(source) {
    var lines = String(source == null ? "" : source).replace(/\r\n?/g, "\n").split("\n");
    var out = [];
    var paragraph = [];
    var list = "";

    function flushParagraph() {
      if (paragraph.length) {
        out.push("<p>" + paragraph.join("<br>") + "</p>");
        paragraph = [];
      }
    }
    function closeList() {
      if (list) {
        out.push("</" + list + ">");
        list = "";
      }
    }

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];

      if (/^\s*```/.test(line)) {
        flushParagraph();
        closeList();
        var buffer = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buffer.push(lines[i]);
          i += 1;
        }
        out.push("<pre><code>" + esc(buffer.join("\n")) + "</code></pre>");
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }
      if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
        flushParagraph();
        closeList();
        out.push("<hr>");
        continue;
      }

      var heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        closeList();
        var level = Math.min(5, heading[1].length + 1);
        out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
        continue;
      }

      var quote = /^>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph();
        closeList();
        var quoted = [quote[1]];
        while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) {
          i += 1;
          quoted.push(lines[i].replace(/^>\s?/, ""));
        }
        out.push("<blockquote>" + quoted.map(inline).join("<br>") + "</blockquote>");
        continue;
      }

      var bullet = /^[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        if (list !== "ul") {
          closeList();
          out.push("<ul>");
          list = "ul";
        }
        out.push("<li>" + inline(bullet[1]) + "</li>");
        continue;
      }

      var ordered = /^\d+[.)]\s+(.*)$/.exec(line);
      if (ordered) {
        flushParagraph();
        if (list !== "ol") {
          closeList();
          out.push("<ol>");
          list = "ol";
        }
        out.push("<li>" + inline(ordered[1]) + "</li>");
        continue;
      }

      closeList();
      paragraph.push(inline(line));
    }

    flushParagraph();
    closeList();
    return out.join("\n");
  }

  /* ---------------- 关过哪些公告 ---------------- */

  function seenIds() {
    try {
      var list = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
      return Array.isArray(list) ? list.map(String) : [];
    } catch (e) {
      return [];
    }
  }

  function remember(id) {
    try {
      var list = seenIds().filter(function (item) { return item !== id; });
      list.push(id);
      /* 只记最近 50 条，免得 localStorage 越攒越多 */
      localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-50)));
    } catch (e) {
      /* 隐私模式存不了就算了，下次打开再弹一次 */
    }
  }

  /* ---------------- 弹窗 ---------------- */

  function show(item) {
    var id = String(item.id || "");
    var badge = esc(t("重要公告"));
    var okLabel = esc(t("我知道了"));
    var linkLabel = esc(t("查看详情"));
    var link = item.link && safeUrl(item.link)
      ? '<a class="bb-imp-link" href="' + esc(item.link) + '" target="_blank" rel="noopener noreferrer">' + linkLabel + "</a>"
      : "";

    var wrap = document.createElement("div");
    wrap.className = "bb-imp";
    /* 公告正文是后台现写的，交给 i18n 逐句查表反而可能被误替换，这里整块跳过；按钮文字在上面已经过 BB.t() */
    wrap.setAttribute("data-i18n-skip", "");
    wrap.innerHTML =
      '<div class="bb-imp-mask" data-close></div>' +
      '<div class="bb-imp-card" role="dialog" aria-modal="true" aria-labelledby="bbImpTitle">' +
        '<div class="bb-imp-head">' +
          '<span class="bb-imp-badge">' + badge + "</span>" +
          (item.date ? '<span class="bb-imp-date">' + esc(item.date) + "</span>" : "") +
        "</div>" +
        '<h3 class="bb-imp-title" id="bbImpTitle">' + esc(item.title || t("重要公告")) + "</h3>" +
        '<div class="bb-imp-body">' + renderMarkdown(item.content) + "</div>" +
        '<div class="bb-imp-actions">' + link +
          '<button class="bb-imp-ok" type="button" data-close>' + okLabel + "</button>" +
        "</div>" +
      "</div>";
    document.body.appendChild(wrap);
    document.body.classList.add("bb-imp-open");

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (id) remember(id);
      document.removeEventListener("keydown", onKey);
      wrap.remove();
      document.body.classList.remove("bb-imp-open");
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }

    wrap.addEventListener("click", function (event) {
      if (event.target && event.target.hasAttribute("data-close")) close();
    });
    document.addEventListener("keydown", onKey);

    var ok = wrap.querySelector(".bb-imp-ok");
    if (ok) ok.focus({ preventScroll: true });
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    fetch("announcement.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var item = data && data.important;
        if (!item || !item.title || !item.content) return;
        var id = String(item.id || "");
        if (id && seenIds().indexOf(id) >= 0) return;
        show(item);
      })
      .catch(function () {
        /* 拉不到公告文件：正常浏览，什么都不显示 */
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
