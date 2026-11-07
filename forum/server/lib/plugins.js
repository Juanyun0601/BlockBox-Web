/**
 * 插件帖的插件包处理：校验 → 解清单 → 落盘 → 记 uploads 表。
 *
 * 校验链（缺一不可）：
 * 1. 扩展名 .BlockBox（大小写不敏感）——用户侧的识别约定；
 * 2. 文件头 "PK\x03\x04"——真实是 zip；
 * 3. 大小 ≤ config.maxPluginBytes——防滥用；
 * 4. 包根目录必须能解出 plugin.json，且 id / name 齐全——和启动器侧
 *    PluginManager 的最低要求一致，防止把随便一个 zip 挂到帖子上。
 *
 * 清单一律以服务端解包读到的为准（version / author / description / icon），
 * 客户端上报的元数据不采信。图标是包内 PNG/JPG，落盘成普通站内图片，
 * 复用 /uploads 静态服务，CDN 开启后天然跟着走 CDN。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { badRequest } from './http.js';
import { detectImage } from './images.js';
import { readCentralEntries, extractEntryToMemory, findEntry } from './zipfile.js';

/** zip 本地文件头签名（PK\x03\x04） */
function isZipBuffer(buffer) {
  return (
    buffer.length > 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

/** 清单字段规整：只要字符串，掐掉控制字符并限长 */
function cleanmanifestText(value, max) {
  const raw = typeof value === 'string' ? value : '';
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 解析一个 .BlockBox 字节流，失败抛 badRequest。
 * 返回 { manifest, entries, iconBuffer, iconExt }
 */
export function inspectPluginPackage(buffer) {
  if (!buffer || buffer.length < 22) throw badRequest('插件包内容为空', 'plugin_invalid');
  if (isZipBuffer(buffer) === false) throw badRequest('插件包不是有效的 BlockBox 插件（应为 zip 格式）', 'plugin_invalid');

  const entries = readCentralEntries(buffer);
  if (!entries || entries.length === 0) {
    throw badRequest('插件包损坏或不是有效的 BlockBox 插件（应为 zip 格式）', 'plugin_invalid');
  }

  const manifestEntry = findEntry(entries, 'plugin.json');
  if (!manifestEntry) {
    throw badRequest('插件包里没有 plugin.json 清单，无法作为插件发布', 'plugin_manifest_missing');
  }
  const manifestBuffer = extractEntryToMemory(buffer, manifestEntry, 1024 * 1024);
  if (!manifestBuffer) throw badRequest('插件清单 plugin.json 无法读取', 'plugin_manifest_missing');

  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
  } catch {
    throw badRequest('插件清单 plugin.json 不是合法的 JSON', 'plugin_manifest_bad');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw badRequest('插件清单格式不正确', 'plugin_manifest_bad');
  }

  const id = cleanmanifestText(manifest.id, 64);
  const name = cleanmanifestText(manifest.name, 64);
  if (!id || !name) {
    throw badRequest('插件清单缺少 id 或 name 字段', 'plugin_manifest_bad');
  }

  // 顺手提取包内图标：只收 PNG / JPG，别的格式静默忽略（图标可缺省）
  let iconBuffer = null;
  let iconExt = null;
  const iconField = cleanmanifestText(manifest.icon, 200);
  if (iconField && !iconField.includes('..')) {
    const iconEntry = findEntry(entries, iconField.replace(/^\/+/, ''));
    if (iconEntry && iconEntry.uncompressedSize <= 512 * 1024) {
      const candidate = extractEntryToMemory(buffer, iconEntry, 512 * 1024);
      const detected = candidate ? detectImage(candidate) : null;
      // gif/webp 也能过 detectImage，但作为插件图标只落 png / jpg
      if (candidate && detected && (detected.ext === 'png' || detected.ext === 'jpg')) {
        iconBuffer = candidate;
        iconExt = detected.ext;
      }
    }
  }

  const version = cleanmanifestText(manifest.version, 32);
  const author = cleanmanifestText(manifest.author, 64);
  const description = cleanmanifestText(manifest.description, 400);

  return {
    manifest,
    pluginId: id,
    name,
    version,
    author,
    description,
    iconBuffer,
    iconExt,
  };
}

/**
 * 校验并保存一个插件包，返回挂帖所需的数据。
 * 文件落在 uploads 目录（前缀 plg-），与图片共用静态服务与 CDN 通道。
 */
export function savePluginPackage(buffer, { userId }) {
  if (!buffer || buffer.length === 0) throw badRequest('插件包内容为空');
  if (buffer.length > config.maxPluginBytes) {
    throw badRequest(
      `插件包太大了，请控制在 ${Math.round(config.maxPluginBytes / 1024 / 1024)} MB 以内`,
      'plugin_too_large',
    );
  }

  const info = inspectPluginPackage(buffer);

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const base = `plg-${userId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const filename = `${base}.BlockBox`;
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadDir, filename), buffer);

  // 包内图标存成普通站内图片（复用图片静态服务，CDN 可直接回源）
  let iconUrl = '';
  if (info.iconBuffer) {
    const iconName = `${base}_icon.${info.iconExt}`;
    try {
      fs.writeFileSync(path.join(config.uploadDir, iconName), info.iconBuffer);
      iconUrl = `/uploads/${iconName}`;
    } catch {
      // 图标存失败了不影响主流程，卡片上用缺省图标
    }
  }

  const inserted = db
    .prepare(
      `INSERT INTO uploads (user_id, url, thumb, mime, width, height, size, kind, meta, created_at)
       VALUES (?, ?, NULL, ?, 0, 0, ?, 'plugin', ?, ?)`,
    )
    .run(
      userId,
      `/uploads/${filename}`,
      'application/octet-stream',
      buffer.length,
      JSON.stringify({
        plugin_id: info.pluginId,
        plugin_name: info.name,
        plugin_version: info.version,
        plugin_author: info.author,
        plugin_description: info.description,
        plugin_icon: iconUrl,
        file_hash: hash,
      }),
      now(),
    );

  return {
    upload_id: Number(inserted.lastInsertRowid),
    url: `/uploads/${filename}`,
    plugin_id: info.pluginId,
    name: info.name,
    version: info.version,
    author: info.author,
    description: info.description,
    icon: iconUrl,
    file_size: buffer.length,
    file_hash: hash,
  };
}
