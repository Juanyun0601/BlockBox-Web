/**
 * 版本发布：管理后台发布新版本，官网与启动器来读。
 *
 * 数据以后台数据库为准：每个版本一行（版本号 + 更新日志 + 是否现行版本），
 * 安装包文件落 config.releaseDir（上传时写入，{_downloads/…} 路径形如
 * /releases/files/<版本>/<文件名>），库里只记清单与 sha256 指纹。
 *
 * 每次发布/下架都会把最新版本写进官网根目录 latest.json（与 announcement.json
 * 同目录、同样的落盘机制），官网首页与启动器按版本号比较，无需发版。
 *
 * 下发格式对齐 GitHub Releases：JSON 主体带上 tag_name / body / prerelease
 * / assets 等字段，客户端复用「按通道挑 Release、按平台挑资产」的既有解析。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, now, transaction } from '../db.js';
import { HttpError, badRequest, notFound, serveFile } from './http.js';
import { isVerified, signDownloadToken, verifyDownloadToken } from './human-check.js';

/** 版本说明（Markdown）与版本号长度上限 */
const MAX_VERSION = 32;
const MAX_NOTES = 8000;
/** 允许的平台标记（上传表单与启动器资产名共用这套词表） */
export const PLATFORMS = [
  ['win64', 'Windows x64'],
  ['winarm64', 'Windows ARM64'],
  ['linux-x64', 'Linux x64'],
  ['linux-arm64', 'Linux ARM64'],
  ['android-arm64-v8a', 'Android（arm64）'],
  ['android-x86_64', 'Android（x86_64）'],
  ['harmony-arm64-v8a', 'HarmonyOS'],
  ['other', '其他'],
];
const PLATFORM_KEYS = PLATFORMS.map(([key]) => key);

/** latest.json 里最多保留多少个启用版本（更新日志往下翻得完） */
export const MAX_EXPORT_VERSIONS = 12;
/**
 * 服务器文件组保留策略：最新两个正式版 + 最新两个测试版的安装包留在官方源，
 * 更旧版本的文件组自动清理；版本号、更新日志与网盘链接永久保留。
 */
export const RETAIN_PER_CHANNEL = 2;

/** 网盘链接只认 http(s) 完整地址，空串表示没填 */
function sanitizeHttpLink(value) {
  const link = String(value == null ? '' : value).trim();
  if (!link) return '';
  if (link.length > 500) return '';
  if (!/^https?:\/\//i.test(link)) return '';
  try {
    return new URL(link).host ? link : '';
  } catch {
    return '';
  }
}

/** 是否测试版（版本号带 beta/alpha/rc/dev 字样），与下发 JSON 的 prerelease 判定一致 */
function isBetaVersion(version) {
  return /beta|alpha|rc|dev/i.test(String(version || ''));
}

/* ----------------------------- 站内路径约定 ----------------------------- */
// 版本号只允许字母数字与 . _ - +，杜绝路径穿越（如 "beta8/..%2F"）
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
// 落盘文件名同样收紧：可读字符，不含路径分隔符
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._()+-]{0,127}$/;

/** 当前生效（enabled=1 且有可用文件）的最新版本行，没有则 null */
export function latestVersion() {
  return (
    db
      .prepare(
        `SELECT v.id, v.version, v.notes, v.created_at
           FROM release_versions v
          WHERE v.enabled = 1
          ORDER BY v.created_at DESC, v.id DESC
          LIMIT 1`,
      )
      .get() || null
  );
}

/** 一个版本的文件清单 */
function filesFor(versionId) {
  return db
    .prepare(
      `SELECT id, platform, filename, size, sha256, downloads, created_at
         FROM release_files
        WHERE version_id = ?
        ORDER BY
          CASE platform
            WHEN 'win64' THEN 0 WHEN 'winarm64' THEN 1 WHEN 'linux-x64' THEN 2
            WHEN 'linux-arm64' THEN 3 WHEN 'android-arm64-v8a' THEN 4
            WHEN 'android-x86_64' THEN 5 WHEN 'harmony-arm64-v8a' THEN 6
            ELSE 9 END,
          id ASC`,
    )
    .all(versionId);
}

/** 把一个版本行渲染成 GitHub Releases 兼容的 Release 对象（公开接口复用）
 *  withToken=true（启动器）：browser_download_url 附带短时效下载令牌，免人机验证 */
export function getReleasePayload(row, { withToken = false } = {}) {
  const files = filesFor(row.id);
  const assets = files.map((file) => {
    const pathPart = `/releases/files/${encodeURIComponent(row.version)}/${encodeURIComponent(file.filename)}`;
    let browserUrl = config.publicDownloadsBase ? config.publicDownloadsBase + pathPart : pathPart;
    if (withToken) {
      const { token } = signDownloadToken(row.version, file.filename);
      browserUrl += `${browserUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
    }
    // GitHub 资产字段同形；browser_download_url 指向安装包直链（CDN 开启时即 CDN 域名）
    return {
      name: file.filename,
      size: file.size,
      digest: file.sha256 ? `sha256:${file.sha256}` : '',
      platform: file.platform,
      browser_download_url: browserUrl,
      download_url: pathPart,
    };
  });
  return {
    id: row.id,
    tag_name: row.version,
    name: row.version,
    body: row.notes || '',
    // 网盘直链（123 盘 / 夸克），文件组被清理后旧版本仍从这里下载
    link_123pan: row.link_123pan || '',
    link_quark: row.link_quark || '',
    draft: false,
    prerelease: /beta|alpha|rc|dev/i.test(row.version),
    created_at: new Date(Number(row.created_at) * 1000).toISOString(),
    published_at: new Date(Number(row.created_at) * 1000).toISOString(),
    html_url: 'https://github.com/Juanyun0601/BlockBox/releases/latest',
    assets,
    // 官网直链一键下载按钮用
    files,
  };
}

/** 把一个版本行 + 文件清单渲染成 GitHub Releases 兼容的 Release 对象 */
function toGithubRelease(row, files) {
  return getReleasePayload({ ...row, created_at: row.created_at });
}

/** 官网导出：启用的版本新→旧，每版带文件清单 */
export function listVersionsForExport() {
  const rows = db
    .prepare(
      `SELECT id, version, notes, link_123pan, link_quark, created_at
         FROM release_versions
        WHERE enabled = 1
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(MAX_EXPORT_VERSIONS);
  return rows.map((row) => {
    const release = toGithubRelease(row, filesFor(row.id));
    return {
      id: release.id,
      tag_name: release.tag_name,
      name: release.name,
      body: release.body,
      prerelease: release.prerelease,
      published_at: release.published_at,
      link_123pan: release.link_123pan,
      link_quark: release.link_quark,
      assets: release.assets,
    };
  });
}

/** 官网根目录 latest.json 的结构：launch（一键下载用的精简索引）+ releases（兼容列表） */
function serializeLatest() {
  const releases = listVersionsForExport();
  const doc = {
    version: 1,
    updated: new Date().toISOString(),
    site: 'https://mcblockbox.top/',
    github: 'https://github.com/Juanyun0601/BlockBox/releases/latest',
    // 官网一键下载按钮先把人领到这里过验证（与论坛同域，验证 Cookie 通用）
    gate_base: config.publicGateBase,
    releases,
  };
  const first = releases[0] || null;
  if (first) {
    doc.release = first;
    doc.latest = {
      version: first.tag_name,
      notes: first.body,
      files: first.assets.map((asset) => ({
        platform: asset.platform,
        name: asset.name,
        size: asset.size,
        sha256: asset.digest ? asset.digest.slice('sha256:'.length) : '',
        url: asset.browser_download_url,
      })),
    };
  }
  return doc;
}

function localLatestPath() {
  return path.resolve(config.announcementFile, '..', 'latest.json');
}

/** 把最新版本写进官网 latest.json；写失败抛错，管理后台能看到原因 */
export function writeLatestFile() {
  const target = localLatestPath();
  try {
    fs.writeFileSync(target, `${JSON.stringify(serializeLatest(), null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new HttpError(
      500,
      `写入官网版本文件失败：${target}（${error.code || error.message}）。请确认论坛服务对该文件有写权限。`,
      'latest_write_failed',
    );
  }
}

/** latest.json 当前状态，后台提示「能不能写」 */
export function latestFileStatus() {
  const file = localLatestPath();
  let exists = false;
  let writable = false;
  try {
    exists = fs.statSync(file).isFile();
  } catch {
    exists = false;
  }
  if (exists) {
    let handle = null;
    try {
      handle = fs.openSync(file, 'r+');
      writable = true;
    } catch {
      writable = false;
    } finally {
      if (handle !== null) {
        try {
          fs.closeSync(handle);
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return { path: file, exists, writable };
}

/* ----------------------------- 后台列表/发布 ----------------------------- */

/** 版本号规整：只收 VERSION_RE 里的字符 */
function cleanVersion(value) {
  const raw = String(value == null ? '' : value).trim().replace(/^v(?=[A-Za-z0-9._+-])/i, '');
  if (!raw) throw badRequest('请先填写版本号');
  if (raw.length > MAX_VERSION) throw badRequest('版本号太长');
  if (!VERSION_RE.test(raw)) {
    throw badRequest('版本号只允许字母、数字与 . _ + -，不要带路径或空格');
  }
  return raw;
}

/** 后台版本列表（含未下架的），新的在前；within_retention 标记文件组是否仍在保留范围内 */
export function listVersions({ includeDisabled = true } = {}) {
  const rows = db
    .prepare(
      `SELECT id, version, notes, link_123pan, link_quark, enabled, created_by, created_at
         FROM release_versions
        ORDER BY created_at DESC, id DESC`,
    )
    .all()
    .filter((row) => includeDisabled || row.enabled);

  // 与 pruneReleaseFiles 同一套规则：最新两正式 + 两测试的文件组仍在官方源
  const kept = new Set();
  let stable = 0;
  let beta = 0;
  for (const row of rows) {
    if (isBetaVersion(row.version)) {
      beta += 1;
      if (beta <= RETAIN_PER_CHANNEL) kept.add(row.id);
    } else {
      stable += 1;
      if (stable <= RETAIN_PER_CHANNEL) kept.add(row.id);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    notes: row.notes,
    link_123pan: row.link_123pan || '',
    link_quark: row.link_quark || '',
    enabled: !!row.enabled,
    created_by: row.created_by,
    created_at: row.created_at,
    within_retention: kept.has(row.id),
    files: filesFor(row.id),
  }));
}

/**
 * 保留策略：服务器文件组只留最新 RETAIN_PER_CHANNEL 个正式版与测试版的安装包，
 * 更旧版本的文件组自动清理（磁盘文件 + 文件记录一起删）；
 * 版本号、更新日志与网盘链接在版本表里永久保留。
 * 返回被清理的版本行列表。
 */
export function pruneReleaseFiles() {
  const rows = db
    .prepare('SELECT id, version FROM release_versions ORDER BY created_at DESC, id DESC')
    .all();
  let stable = 0;
  let beta = 0;
  const pruned = [];
  for (const row of rows) {
    if (isBetaVersion(row.version)) {
      beta += 1;
      if (beta <= RETAIN_PER_CHANNEL) continue;
    } else {
      stable += 1;
      if (stable <= RETAIN_PER_CHANNEL) continue;
    }
    pruned.push(row);
  }

  const cleaned = [];
  for (const row of pruned) {
    const files = db.prepare('SELECT filename FROM release_files WHERE version_id = ?').all(row.id);
    if (!files.length) continue;
    transaction(() => {
      db.prepare('DELETE FROM release_files WHERE version_id = ?').run(row.id);
    });
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(config.releaseDir, row.version, file.filename));
      } catch {
        /* 文件已经不在了就随它去 */
      }
    }
    // 文件组清完顺手把空目录也收掉
    try {
      fs.rmdirSync(path.join(config.releaseDir, row.version));
    } catch {
      /* 目录不空（不该发生）或已不存在，忽略 */
    }
    cleaned.push(row);
  }
  return cleaned;
}

/** 这个版本还在保留范围内吗（范围内才允许上传/持有安装包文件） */
export function isVersionWithinRetention(versionId) {
  const rows = db
    .prepare('SELECT id, version FROM release_versions ORDER BY created_at DESC, id DESC')
    .all();
  let stable = 0;
  let beta = 0;
  for (const row of rows) {
    if (isBetaVersion(row.version)) {
      beta += 1;
      if (row.id === Number(versionId)) return beta <= RETAIN_PER_CHANNEL;
    } else {
      stable += 1;
      if (row.id === Number(versionId)) return stable <= RETAIN_PER_CHANNEL;
    }
  }
  return false;
}

/**
 * 版本数据变动后的统一收口：先按保留策略清理旧文件组，再同步官网 latest.json。
 * 清理失败不拦发布（保留策略是后台维护动作，不该挡住管理员），
 * 但 latest.json 写失败要往外抛——后台界面要能看到「文件不可写」的原因。
 */
function syncAfterMutation() {
  try {
    const pruned = pruneReleaseFiles();
    if (pruned.length) {
      console.log(
        `[版本] 按保留策略清理了 ${pruned.length} 个旧版本的文件组：${pruned.map((row) => row.version).join('、')}（版本号与更新日志保留）`,
      );
    }
  } catch (error) {
    console.warn('[版本] 旧版本文件组清理失败：', error.message);
  }
  writeLatestFile();
}

/**
 * 发布 / 更新一个版本：版本号重复就原地更新说明与网盘链接并补文件。
 * 上传文件走 saveReleaseFile，与本函数解耦；这里只动库与 latest.json。
 */
export function publishVersion({ version: rawVersion, notes, link123pan, linkQuark, admin }) {
  const version = cleanVersion(rawVersion);
  const text = String(notes == null ? '' : notes)
    .replace(/\r\n?/g, '\n')
    .slice(0, MAX_NOTES);
  const link123 = sanitizeHttpLink(link123pan);
  const linkQuarkClean = sanitizeHttpLink(linkQuark);

  const existing = db.prepare('SELECT id, version FROM release_versions WHERE version = ?').get(version);
  if (existing) {
    db.prepare('UPDATE release_versions SET notes = ?, link_123pan = ?, link_quark = ?, created_by = ? WHERE id = ?').run(
      text,
      link123,
      linkQuarkClean,
      admin ? String(admin.username) : '',
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO release_versions (version, notes, link_123pan, link_quark, enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(version, text, link123, linkQuarkClean, admin ? String(admin.username) : '', now());
  }

  const row = db
    .prepare('SELECT id, version, notes, link_123pan, link_quark, created_at FROM release_versions WHERE version = ?')
    .get(version);
  syncAfterMutation();
  return toGithubRelease(row, filesFor(row.id));
}

/** 上线 / 下架一个版本；下架后 latest.json 不再下发它 */
export function setVersionEnabled(id, enabled) {
  const numeric = Math.floor(Number(id));
  if (!numeric) throw notFound('版本不存在');
  const row = db.prepare('SELECT id FROM release_versions WHERE id = ?').get(numeric);
  if (!row) throw notFound('版本不存在');
  db.prepare('UPDATE release_versions SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, numeric);
  syncAfterMutation();
}

/** 删除版本：连文件一起删，防止磁盘里堆陈年安装包 */
export function removeVersion(id) {
  const numeric = Math.floor(Number(id));
  if (!numeric) throw notFound('版本不存在');
  const row = db.prepare('SELECT version FROM release_versions WHERE id = ?').get(numeric);
  if (!row) throw notFound('版本不存在');

  const files = filesFor(numeric);
  transaction(() => {
    db.prepare('DELETE FROM release_files WHERE version_id = ?').run(numeric);
    db.prepare('DELETE FROM release_versions WHERE id = ?').run(numeric);
  });
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(config.releaseDir, row.version, file.filename));
    } catch {
      /* 文件已经不在了就随它去 */
    }
  }
  try {
    fs.rmdirSync(path.join(config.releaseDir, row.version));
  } catch {
    /* 目录里还有别的文件或已不存在，忽略 */
  }
  syncAfterMutation();
}

/* ----------------------------- 文件上传/下载 ----------------------------- */

/** 落盘目录：data/releases/<版本>/<文件名> */
function safeResolveDir(version, filename) {
  if (!VERSION_RE.test(String(version))) throw badRequest('版本号不合法');
  if (!FILENAME_RE.test(String(filename))) throw badRequest('文件名不合法');
  const dir = path.resolve(config.releaseDir, String(version));
  const rootWithSep = path.resolve(config.releaseDir) + path.sep;
  if (!dir.startsWith(rootWithSep)) throw badRequest('版本号不合法');
  const target = path.resolve(dir, String(filename));
  if (!target.startsWith(dir + path.sep)) throw badRequest('文件名不合法');
  return { dir, target };
}

/**
 * 保存一个管理员上传的更新包：写入 {config.releaseDir}/<版本>/<文件名>，
 * 已存在（重复上传）时允许覆盖——同名文件管理员有权直接替换。
 * 返回库里这份文件的记录行。
 */
export function saveReleaseFile(buffer, { version, platform, filename, admin }) {
  if (!buffer || buffer.length === 0) throw badRequest('文件内容为空');
  if (buffer.length > config.maxReleaseFileBytes) {
    throw badRequest(
      `文件太大，当前上限 ${Math.round(config.maxReleaseFileBytes / 1024 / 1024)} MB；更大的安装包请走网盘并在说明里贴链接`,
      'file_too_large',
    );
  }

  const versionRow = db.prepare('SELECT id FROM release_versions WHERE version = ?').get(cleanVersion(version));
  if (!versionRow) throw notFound('先在下方「版本号 + 更新日志」创建/确认这个版本，再上传文件');

  // 保留策略之外（非最新两正式 + 两测试）的版本不再收文件：传了也会立刻被清掉
  if (!isVersionWithinRetention(versionRow.id)) {
    throw badRequest(
      '这个版本不在官方源的保留范围内（只保留最新两个正式版和两个测试版的安装包），请把文件传到网盘后把链接填进发布表单',
      'version_out_of_retention',
    );
  }

  const dirName = cleanVersion(version);
  const name = String(filename || '').trim();
  if (!FILENAME_RE.test(name)) throw badRequest('文件名不合法（只允许字母数字与 . _ ( ) + -）');
  const platformKey = PLATFORM_KEYS.includes(platform) ? platform : 'other';
  const { dir, target } = safeResolveDir(dirName, name);

  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(target, buffer);
  } catch (error) {
    throw new HttpError(
      500,
      `保存更新包失败：${target}（${error.code || error.message}）。请确认论坛服务对 releases 目录有写权限。`,
      'release_file_write_failed',
    );
  }

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  db.prepare(
    `INSERT INTO release_files (version_id, platform, filename, size, sha256, downloads, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(version_id, filename) DO UPDATE SET
       platform = excluded.platform,
       size = excluded.size,
       sha256 = excluded.sha256`,
  ).run(versionRow.id, platformKey, name, buffer.length, hash, now());

  syncAfterMutation();
  return db
    .prepare('SELECT id, platform, filename, size, sha256, downloads FROM release_files WHERE version_id = ? AND filename = ?')
    .get(versionRow.id, name);
}

/** 上传/替换文件成功的提示数据（后台列表刷新用） */
export function releaseFileStatus() {
  return { dir: config.releaseDir, max_bytes: config.maxReleaseFileBytes, platforms: PLATFORMS };
}

/** 删除一个文件（磁盘 + 库），删完同步 latest.json */
export function removeReleaseFile(versionId, fileId) {
  const row = db
    .prepare(
      `SELECT f.id, f.filename, f.platform, v.version
         FROM release_files f JOIN release_versions v ON v.id = f.version_id
        WHERE f.version_id = ? AND f.id = ?`,
    )
    .get(Math.floor(Number(versionId)), Math.floor(Number(fileId)));
  if (!row) throw notFound('文件不存在');

  db.prepare('DELETE FROM release_files WHERE id = ?').run(row.id);
  try {
    const { target } = safeResolveDir(row.version, row.filename);
    fs.unlinkSync(target);
  } catch {
    /* 忽略 */
  }
  syncAfterMutation();
}

/** 文件下载计数（官网/直链走这里 +1；网盘、GitHub 的不记） */
export function countReleaseDownload(version, filename) {
  const row = db
    .prepare(
      `SELECT f.id FROM release_files f JOIN release_versions v ON v.id = f.version_id
        WHERE v.version = ? AND f.filename = ?`,
    )
    .get(String(version), String(filename));
  if (row) {
    db.prepare('UPDATE release_files SET downloads = downloads + 1 WHERE id = ?').run(row.id);
  }
}

/**
 * 安装包下载门禁：/releases/files/<版本>/<文件名> 统一从这里出去。
 *
 * 放行顺序：
 * 1. 带有效下载令牌（启动器应用内更新）→ 直接发文件；
 * 2. 已过人机验证（浏览器 Cookie / X-Human-Token）→ 若配了 CDN 且本请求不是
 *    从 CDN 域名进来的，302 引到带新令牌的 CDN 直链（下载走 CDN），否则直接发文件；
 * 3. 都没有 → 302 到人机验证页，过了滑块回跳继续下。
 *
 * 返回 true 表示已响应；false 表示文件不存在（调用方回 404）。
 */
export async function handleReleaseFileRequest(res, { version, filename, cookies, headers, searchParams }) {
  let safe;
  try {
    safe = safeResolveDir(version, filename);
  } catch {
    return false;
  }

  const token = String((searchParams && searchParams.get('t')) || '');
  const tokenOk = verifyDownloadToken(version, filename, token);
  const verified = isVerified(cookies || {}, headers || {});

  if (!tokenOk && !verified) {
    const next = `/releases/files/${encodeURIComponent(version)}/${encodeURIComponent(filename)}`;
    res.writeHead(302, {
      location: `/verify.html?next=${encodeURIComponent(next)}`,
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }

  // 浏览器过完验证来的：能引去 CDN 就引去 CDN（带一次性新令牌），让大文件走边缘节点
  const requestHost = String((headers && headers.host) || '').toLowerCase();
  const cdnHost = config.publicDownloadsBase ? new URL(config.publicDownloadsBase).host.toLowerCase() : '';
  if (verified && !tokenOk && cdnHost && requestHost && requestHost !== cdnHost) {
    const { token: fresh } = signDownloadToken(version, filename, 10 * 60);
    countReleaseDownload(version, filename);
    res.writeHead(302, {
      location: `${config.publicDownloadsBase}/releases/files/${encodeURIComponent(version)}/${encodeURIComponent(filename)}?t=${encodeURIComponent(fresh)}`,
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }

  const served = await serveFile(res, config.releaseDir, `/${encodeURIComponent(version)}/${encodeURIComponent(filename)}`, {
    immutable: true,
    publicResource: true,
    attachment: true,
    // 官网直链下载限速（默认 400KB/s，DOWNLOAD_RATE_LIMIT_KB=0 可关掉）
    maxBytesPerSecond: config.downloadRateLimitKb * 1024,
  });
  if (served) countReleaseDownload(version, filename);
  return served;
}

/** 启动时同步：按保留策略清理旧文件组，再生成/刷新官网 latest.json，避免冷启动 404 或残留过期文件 */
export function initReleases() {
  try {
    if (latestVersion()) {
      syncAfterMutation();
      console.log(`[版本] 版本数据已同步到官网 latest.json（${localLatestPath()}）`);
    } else if (!fs.existsSync(localLatestPath())) {
      writeLatestFile();
      console.log(`[版本] 已生成 ${localLatestPath()}`);
    }
  } catch (error) {
    console.warn(`[版本] latest.json 同步失败：${error.message}`);
  }
}
