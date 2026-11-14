/**
 * 投影帖的投影文件处理：校验 → 落盘 → 记 uploads 表。
 *
 * 服务端不需要读懂投影内容（材料清单、方块统计是启动器本地算的），
 * 只做四件事：
 * 1. 扩展名白名单（.litematic / .schem / .schematic / .nbt），挡住改后缀的压缩包；
 * 2. 文件头检查：投影都是 NBT，要么是 gzip 压缩（1f 8b），要么是裸 NBT（0x0a 起头）；
 * 3. 大小 ≤ config.maxSchematicBytes（默认 50 MB）；
 * 4. 原文件名只收 basename，掐掉路径分隔符与控制字符，防止下载时被拿去做目录穿越。
 *
 * 落盘走 uploads 目录，和图片、插件包共用 /uploads 静态服务，CDN 开启后自动跟着走。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { badRequest } from './http.js';

/** 允许的投影扩展名（小写，不含点） */
const ALLOWED_EXTS = ['litematic', 'schem', 'schematic', 'nbt'];

/** 投影文件都是 NBT：gzip 魔数或裸 NBT 的 TAG_Compound(0x0a) */
function looksLikeNbt(buffer) {
  if (!buffer || buffer.length < 8) return false;
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return true;
  return buffer[0] === 0x0a;
}

/** 文件名只留 basename，去掉控制字符并限长 */
export function cleanFileName(raw) {
  const text = String(raw || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .trim();
  return text.slice(-120);
}

/** 拆出小写扩展名（不含点），没有扩展名返回空串 */
export function extOf(fileName) {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(String(fileName || ''));
  return match ? match[1].toLowerCase() : '';
}

/**
 * 校验并保存一个投影文件，返回挂帖所需的数据。
 * @param {Buffer} buffer
 * @param {{ userId: number, fileName: string }} options
 */
export function saveSchematicFile(buffer, { userId, fileName }) {
  if (!buffer || buffer.length === 0) throw badRequest('投影文件是空的');

  const name = cleanFileName(fileName);
  const ext = extOf(name);
  if (!ext || !ALLOWED_EXTS.includes(ext)) {
    throw badRequest('只接受投影文件（.litematic / .schem / .schematic / .nbt）', 'schematic_ext_invalid');
  }
  if (buffer.length > config.maxSchematicBytes) {
    throw badRequest(
      `投影文件太大了，请控制在 ${Math.round(config.maxSchematicBytes / 1024 / 1024)} MB 以内`,
      'schematic_too_large',
    );
  }
  if (!looksLikeNbt(buffer)) {
    throw badRequest('这个文件不像投影：请用 Litematica / WorldEdit 导出后再上传', 'schematic_invalid');
  }

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const base = `sch-${userId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const storedName = `${base}.${ext}`;
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadDir, storedName), buffer);

  const inserted = db
    .prepare(
      `INSERT INTO uploads (user_id, url, thumb, mime, width, height, size, kind, meta, created_at)
       VALUES (?, ?, NULL, ?, 0, 0, ?, 'schematic', ?, ?)`,
    )
    .run(
      userId,
      `/uploads/${storedName}`,
      'application/octet-stream',
      buffer.length,
      JSON.stringify({ file_name: name, file_hash: hash }),
      now(),
    );

  return {
    upload_id: Number(inserted.lastInsertRowid),
    name: name.replace(/\.[A-Za-z0-9]{1,12}$/, '') || name,
    file_name: name,
    file_size: buffer.length,
    file_hash: hash,
    url: `/uploads/${storedName}`,
  };
}
