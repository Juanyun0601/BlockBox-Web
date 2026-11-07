/* 一键下载：拉取 latest.json（论坛后台「版本发布」自动维护），
   按访客系统与架构自动挑选安装包，点击即从官网源下载（浏览器首次需过一次人机验证）。
   国际用户可直接用页面上的 GitHub 按钮；拉不到版本信息时按钮保持原跳转，不影响浏览。 */
(function () {
  var buttons = document.querySelectorAll('[data-quick-download]');
  var quick = document.getElementById('dlQuickBtn');
  if (!buttons.length && !quick) return;

  var latest = null;

  function detectOS() {
    var ua = navigator.userAgent || '';
    var uad = navigator.userAgentData || null;
    var platform = (uad && uad.platform) || navigator.platform || '';
    if (/HarmonyOS|OpenHarmony/i.test(ua)) return 'harmony';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Mac OS X|Macintosh|iPhone|iPad/i.test(ua)) return 'macos';
    if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
    if (/^Win/i.test(platform)) return 'windows';
    if (/^Mac/i.test(platform)) return 'macos';
    if (/^Linux|^X11/i.test(platform)) return 'linux';
    return '';
  }

  function detectArch(ua) {
    if (/aarch64|arm64/i.test(ua)) return 'arm64';
    if (/win64|x86_64|x64|amd64|wow64/i.test(ua)) return 'x64';
    if (/armv7|arm/i.test(ua)) return 'arm32';
    if (/i[3-6]86/i.test(ua)) return 'x86';
    return '';
  }

  /* 从版本资产里挑当前系统最合适的安装包；挑不出返回 null（按钮退回下载页） */
  function pickAsset(release, os, arch) {
    if (!release || !release.assets || !release.assets.length) return null;
    function byPlatform(tag) {
      return release.assets.filter(function (a) { return a.platform === tag; });
    }
    function prefer(list, suffix) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].name.toLowerCase().indexOf(suffix) >= 0) return list[i];
      }
      return list[0] || null;
    }
    if (os === 'windows') {
      var pool = byPlatform(arch === 'arm64' ? 'winarm64' : 'win64');
      if (!pool.length && arch === 'arm64') pool = byPlatform('win64');
      return prefer(pool, '-setup.exe');
    }
    if (os === 'linux') {
      var pool2 = byPlatform(arch === 'arm64' ? 'linux-arm64' : 'linux-x64');
      if (!pool2.length && arch === 'arm64') pool2 = byPlatform('linux-x64');
      return prefer(pool2, '.deb');
    }
    if (os === 'android') {
      var pool3 = byPlatform(arch === 'x86' || arch === 'x64' ? 'android-x86_64' : 'android-arm64-v8a');
      return prefer(pool3, '.apk');
    }
    if (os === 'harmony') {
      return prefer(byPlatform('harmony-arm64-v8a'), '.hap');
    }
    return null;
  }

  /* 浏览器下载地址：优先官网验证入口（与论坛同域，过一次滑块即可），配了 CDN 也一样走它 */
  function fileUrl(asset) {
    if (!asset) return '';
    var relative = asset.download_url || asset.url || '';
    if (relative && latest && latest.gate_base) return latest.gate_base + relative;
    return asset.browser_download_url || relative;
  }

  fetch('latest.json', { cache: 'no-store' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.release) return;
      latest = data;

      var version = data.release.tag_name || '';
      var os = detectOS();
      var arch = detectArch(navigator.userAgent || '');
      var asset = pickAsset(data.release, os, arch);

      /* 首页：平台行前加一枚「最新版本」徽标；下载区副标题说明已选好安装包 */
      var badgeHost = document.getElementById('heroDlNote');
      if (badgeHost && version && !badgeHost.querySelector('.qd-version')) {
        var badge = document.createElement('span');
        badge.className = 'qd-version';
        badge.style.cssText =
          'margin-right:10px;padding:2px 10px;border-radius:999px;' +
          'background:rgba(34,197,94,.15);color:#16a34a;font-weight:700;';
        badge.textContent = '最新版本 ' + version;
        badgeHost.insertBefore(badge, badgeHost.firstChild);
      }
      var sectionNote = document.getElementById('sectionDlNote');
      if (sectionNote && version) {
        sectionNote.hidden = false;
        sectionNote.textContent = asset
          ? '最新版本 ' + version + '，已按你的系统选好安装包，点上面按钮立即下载；国际网络可用 GitHub。'
          : '最新版本 ' + version + '，请到下载页选择对应系统的安装包。';
      }

      /* 下载页：版本标题、一键下载按钮 */
      var nameEl = document.getElementById('dlVersionName');
      if (nameEl && version) nameEl.textContent = version;
      var tagEl = document.getElementById('dlVersionTag');
      if (tagEl && data.release.prerelease !== undefined) {
        tagEl.textContent = data.release.prerelease ? '公测版' : '正式版';
      }
      /* 网盘链接随版本走：后台发布时填了 123 盘 / 夸克就替换成最新地址（没填则保留页面原有链接） */
      var pan123 = document.getElementById('dlPan123Btn');
      if (pan123 && data.release.link_123pan) pan123.href = data.release.link_123pan;
      var quark = document.getElementById('dlQuarkBtn');
      if (quark && data.release.link_quark) quark.href = data.release.link_quark;
      if (quick) {
        if (asset) {
          quick.href = fileUrl(asset);
          quick.hidden = false;
          var quickNote = document.getElementById('dlQuickNote');
          if (quickNote) {
            quickNote.textContent =
              '已识别你的系统，点击即从官网源下载 ' + asset.name +
              '（首次下载需完成一次滑块验证）';
          }
        } else {
          quick.hidden = true;
        }
      }

      /* 首页两个大按钮：识别成功才接管点击，否则保持跳下载页 */
      if (!asset || !buttons.length) return;
      var url = fileUrl(asset);
      buttons.forEach(function (button) {
        button.addEventListener('click', function (event) {
          event.preventDefault();
          window.location.href = url;
        });
      });
    })
    .catch(function () {
      /* 拉不到版本信息：按钮维持原跳转（download.html） */
    });
})();
