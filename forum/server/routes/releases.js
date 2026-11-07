/**
 * 版本发布路由：管理后台的发布/文件管理，加上官网与启动器的公开读取。
 *
 * 公开部分故意不带「论坛」语义：/api/app/releases/* 与 GitHub Releases
 * 接口形状对齐（数组项含 tag_name/body/prerelease/assets），启动器
 * UpdateChecker 与官网下载页都能直接解析，无需为自家协议写两套。
 *
 * 管理 / 公开的分界：写操作必须 requireAdmin；读操作全部匿名开放，
 * 因为人机验证门禁只对 forum 页面游客生效，启动器不该被滑块拦住更新检查。
 */
import { db } from '../db.js';
import { badRequest, notFound, readRawBody } from '../lib/http.js';
import { requireAdmin } from '../lib/auth.js';
import { config } from '../config.js';
import { getReleasePayload } from '../lib/releases.js';
import {
  latestFileStatus,
  listVersions,
  publishVersion,
  releaseFileStatus,
  removeReleaseFile,
  removeVersion,
  saveReleaseFile,
  setVersionEnabled,
} from '../lib/releases.js';

export default function register(router) {
  // ---------------- 公开：给官网与启动器（匿名可读） ----------------

  /** 兼容 GitHub 的 Releases 列表形状：browser_download_url 带下载令牌，启动器免验证直下 */
  router.get('/api/app/releases', async () => {
    const rows = db
      .prepare(
        `SELECT id, version, notes, link_123pan, link_quark, created_at
           FROM release_versions
          WHERE enabled = 1
          ORDER BY created_at DESC, id DESC
          LIMIT 20`,
      )
      .all();
    return rows.map((row) => getReleasePayload(row, { withToken: true }));
  });

  /** 兼容 GitHub 的 /releases/latest：只回一个最新的启用版本（同样带令牌） */
  router.get('/api/app/releases/latest', async () => {
    const row = db
      .prepare(
        `SELECT id, version, notes, link_123pan, link_quark, created_at
           FROM release_versions
          WHERE enabled = 1
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get();
    if (!row) throw notFound('还没有发布任何版本');
    return getReleasePayload(row, { withToken: true });
  });

  /** 健康检查可达的版本向量（顺带给 CDN 缓存刷新探测） */
  router.get('/api/app/releases/health', async () => {
    const row = db
      .prepare('SELECT version, created_at FROM release_versions WHERE enabled = 1 ORDER BY created_at DESC LIMIT 1')
      .get();
    return {
      ok: true,
      latest: row ? row.version : '',
      updated: row ? Number(row.created_at) : 0,
    };
  });

  // ---------------- 管理后台 ----------------

  /** 版本列表（含已下架的）+ 文件信息 + latest.json 状态 */
  router.get('/api/admin/releases', async (ctx) => {
    requireAdmin(ctx.user);
    return {
      versions: listVersions(),
      file: latestFileStatus(),
      upload: releaseFileStatus(),
    };
  });

  /** 发布（或更新说明与网盘链接）一个版本 */
  router.post('/api/admin/releases', async (ctx) => {
    const admin = requireAdmin(ctx.user);
    const body = await ctx.json();
    return {
      ok: true,
      release: publishVersion({
        version: body.version,
        notes: body.notes,
        link123pan: body.link_123pan,
        linkQuark: body.link_quark,
        admin,
      }),
      file: latestFileStatus(),
    };
  });

  /** 上线 / 下架 */
  router.patch('/api/admin/releases/:id', async (ctx) => {
    requireAdmin(ctx.user);
    const body = await ctx.json();
    if (typeof body.enabled !== 'boolean') throw badRequest('缺少 enabled 字段');
    setVersionEnabled(ctx.params.id, body.enabled);
    return { ok: true };
  });

  /** 删除版本（连文件带库记录） */
  router.delete('/api/admin/releases/:id', async (ctx) => {
    requireAdmin(ctx.user);
    removeVersion(ctx.params.id);
    return { ok: true };
  });

  /**
   * 上传安装包：URL 里带版本号与目标平台，body 是原始文件字节。
   * 成功返回文件记录（后台列表立刻能看到）。
   */
  router.post('/api/admin/releases/:id/files', async (ctx) => {
    const admin = requireAdmin(ctx.user);
    const versionRow = db
      .prepare('SELECT id, version FROM release_versions WHERE id = ?')
      .get(Math.floor(Number(ctx.params.id)));
    if (!versionRow) throw notFound('版本不存在');

    const platform = String(ctx.url.searchParams.get('platform') || 'other');
    const body = await readRawBody(ctx.req, config.maxReleaseFileBytes);

    const filename =
      ctx.url.searchParams.get('filename') || ctx.req.headers['x-filename'] || `BlockBox-${versionRow.version}-${platform}.bin`;
    const saved = saveReleaseFile(body, {
      version: versionRow.version,
      platform,
      filename: String(filename).split(/[\\/]/).pop(),
      admin,
    });
    return { ok: true, file: saved };
  });

  /** 删除一个安装包文件 */
  router.delete('/api/admin/releases/:id/files/:fileId', async (ctx) => {
    requireAdmin(ctx.user);
    removeReleaseFile(ctx.params.id, ctx.params.fileId);
    return { ok: true };
  });
}
