/* ============================================================
   更新日志页：读取 latest.json，渲染版本列表与各版本更新内容
   数据由论坛后台「版本发布」生成，字段见 server/lib/releases.js
   ============================================================ */
(function () {
  'use strict';

  var T = function (s) {
    return (window.BB && window.BB.t) ? window.BB.t(s) : s;
  };

  var els = {
    versions: document.getElementById('clVersions'),
    state: document.getElementById('clState'),
    release: document.getElementById('clRelease'),
    tag: document.getElementById('clTag'),
    date: document.getElementById('clDate'),
    title: document.getElementById('clVersionTitle'),
    summary: document.getElementById('clSummary'),
    links: document.getElementById('clLinks'),
    notes: document.getElementById('clNotes')
  };
  if (!els.versions || !els.release) return;

  var versions = [];
  var RELEASES_URL = 'https://github.com/Juanyun0601/BlockBox/releases';

  /* ------------------------- 基础工具 ------------------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function safeUrl(u) {
    u = String(u == null ? '' : u).trim();
    if (/^(https?:\/\/|\/|#|mailto:)/i.test(u)) return u;
    return '';
  }

  /* ------------------------- Markdown ------------------------- */

  function inline(text) {
    var s = esc(text);
    s = s.replace(/`([^`]+)`/g, function (m, code) {
      return '<code>' + code + '</code>';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      var safe = safeUrl(url);
      if (!safe) return label;
      return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return s;
  }

  function matchList(line) {
    var m = line.match(/^[-*+]\s+(.+)$/);
    if (m) return { type: 'ul', text: m[1] };
    m = line.match(/^\d+[.)]\s+(.+)$/);
    if (m) return { type: 'ol', text: m[1] };
    return null;
  }

  function renderNotes(src) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var para = [];
    var list = null;
    var quote = [];

    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
    function flushList() {
      if (!list) return;
      out.push('<' + list.type + '>' + list.items.map(function (item) {
        return '<li>' + inline(item) + '</li>';
      }).join('') + '</' + list.type + '>');
      list = null;
    }
    function flushQuote() {
      if (!quote.length) return;
      out.push('<blockquote><p>' + inline(quote.join(' ')) + '</p></blockquote>');
      quote = [];
    }
    function flushAll() { flushPara(); flushList(); flushQuote(); }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.replace(/\s+$/, '');

      if (!line) {
        if (list) {
          var j = i + 1;
          while (j < lines.length && !lines[j].replace(/\s+$/, '')) j++;
          if (j < lines.length) {
            var next = matchList(lines[j]);
            if (next && next.type === list.type) continue;
          }
          flushList();
        }
        flushPara();
        flushQuote();
        continue;
      }

      if (/^```/.test(line)) {
        flushAll();
        var buf = [];
        for (i++; i < lines.length; i++) {
          if (/^```/.test(lines[i])) break;
          buf.push(lines[i]);
        }
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      var heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushAll();
        var level = Math.min(heading[1].length + 1, 6);
        out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
        continue;
      }

      if (/^([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        flushAll();
        out.push('<hr>');
        continue;
      }

      var q = line.match(/^>\s?(.*)$/);
      if (q) {
        flushPara();
        flushList();
        quote.push(q[1]);
        continue;
      }

      var item = matchList(line);
      if (item) {
        flushPara();
        flushQuote();
        if (!list || list.type !== item.type) {
          flushList();
          list = { type: item.type, items: [] };
        }
        list.items.push(item.text);
        continue;
      }

      if (list && /^(\s{2,}|\t)/.test(raw)) {
        list.items[list.items.length - 1] += ' ' + line.trim();
        continue;
      }

      flushList();
      flushQuote();
      para.push(line.trim());
    }

    flushAll();
    return out.join('');
  }

  /* ------------------------- 数据整理 ------------------------- */

  function normalize(r) {
    var version = String(r.tag_name || r.name || '—');
    return {
      version: version,
      name: r.name && r.name !== version ? String(r.name) : '',
      body: String(r.body || ''),
      date: String(r.published_at || '').slice(0, 10),
      prerelease: r.prerelease === true || /(alpha|beta|rc|dev)/i.test(version),
      links: [
        { label: '123 盘', url: safeUrl(r.link_123pan) },
        { label: '夸克网盘', url: safeUrl(r.link_quark) },
        { label: 'GitHub', url: safeUrl(r.link_github) }
      ].filter(function (x) { return !!x.url; })
    };
  }

  /* ------------------------- 渲染 ------------------------- */

  function buildVersions() {
    var frag = document.createDocumentFragment();

    versions.forEach(function (v, idx) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cl-ver';
      btn.setAttribute('aria-current', 'false');
      btn.setAttribute('data-index', String(idx));

      var head = document.createElement('span');
      head.className = 'cl-ver-main';

      var name = document.createElement('span');
      name.className = 'cl-ver-name';
      name.textContent = v.version;
      head.appendChild(name);

      var tag = document.createElement('span');
      tag.className = 'cl-tag' + (v.prerelease ? '' : ' is-stable');
      tag.textContent = T(v.prerelease ? '公测版' : '正式版');
      head.appendChild(tag);
      btn.appendChild(head);

      var date = document.createElement('span');
      date.className = 'cl-ver-date';
      date.textContent = v.date;
      btn.appendChild(date);

      btn.addEventListener('click', function () { select(idx, true); });
      frag.appendChild(btn);
    });

    els.versions.appendChild(frag);
  }

  function select(idx, fromUser) {
    if (!versions.length) return;
    if (!(idx >= 0 && idx < versions.length)) idx = 0;

    var v = versions[idx];

    Array.prototype.forEach.call(els.versions.children, function (btn, i) {
      var on = i === idx;
      btn.classList.toggle('is-active', on);
      if (on) btn.setAttribute('aria-current', 'true');
      else btn.setAttribute('aria-current', 'false');
    });

    els.state.hidden = true;
    els.release.hidden = false;

    els.tag.textContent = T(v.prerelease ? '公测版' : '正式版');
    els.tag.className = 'cl-tag' + (v.prerelease ? '' : ' is-stable');

    els.date.textContent = v.date;
    if (v.date) els.date.setAttribute('datetime', v.date);

    els.title.textContent = v.version;

    els.summary.textContent = v.name;
    els.summary.hidden = !v.name;

    els.links.innerHTML = '';
    v.links.forEach(function (link) {
      var a = document.createElement('a');
      a.className = 'btn btn-ghost btn-sm';
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = T(link.label);
      els.links.appendChild(a);
    });
    els.links.hidden = v.links.length === 0;

    els.notes.innerHTML = v.body ? renderNotes(v.body) : '<p class="cl-notes-empty">—</p>';

    try {
      history.replaceState(null, '', '#' + encodeURIComponent(v.version));
    } catch (e) { /* file:// 等环境忽略 */ }

    if (fromUser && window.matchMedia && window.matchMedia('(max-width: 1024px)').matches) {
      els.release.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function hashIndex() {
    var h = location.hash.replace(/^#/, '');
    try { h = decodeURIComponent(h); } catch (e) { /* 保持原样 */ }
    if (!h) return -1;
    for (var i = 0; i < versions.length; i++) {
      if (versions[i].version.toLowerCase() === h.toLowerCase()) return i;
    }
    return -1;
  }

  function showEmpty(message) {
    var layout = document.querySelector('.cl-layout');
    if (layout) layout.classList.add('is-empty');
    els.state.hidden = false;
    els.state.textContent = message + ' ';
    var a = document.createElement('a');
    a.href = RELEASES_URL;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'GitHub Releases';
    els.state.appendChild(a);
  }

  /* ------------------------- 启动 ------------------------- */

  fetch('latest.json', { cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      var list = [];
      if (data && Array.isArray(data.releases) && data.releases.length) {
        list = data.releases.slice();
      } else if (data && data.release) {
        list = [data.release];
      }
      versions = list.map(normalize);

      if (!versions.length) {
        showEmpty(T('暂时没有读取到版本记录，请稍后刷新页面。'));
        return;
      }

      buildVersions();
      var idx = hashIndex();
      select(idx < 0 ? 0 : idx, false);
    })
    .catch(function (err) {
      showEmpty(T('暂时没有读取到版本记录，请稍后刷新页面。'));
      if (window.console) console.warn('[changelog] 读取 latest.json 失败：', err);
    });

  window.addEventListener('hashchange', function () {
    if (!versions.length) return;
    var idx = hashIndex();
    select(idx < 0 ? 0 : idx, false);
  });
})();
