/**
 * 教程帖的资料附件处理：校验 → 落盘 → 记 uploads 表。
 *
 * 和投影文件同一条流水线，只做四件事：
 * 1. 扩展名白名单（config.attachmentExts：pdf / zip / rar / 7z / txt / md 等文档与压缩包）；
 * 2. 大小 ≤ config.maxFileBytes（默认 50 MB）；
 * 3. 原文件名只收 basename，掐掉路径分隔符与控制字符（cleanFileName 与投影共用），
 *    防止下载时被拿去做目录穿越；
 * 4. 不读内容：资料包里是什么服务端不关心，下载原样回给用户。
 *
 * 落盘走 uploads 目录，和图片、插件包共用 /uploads 静态服务，CDN 开启后自动跟着走。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { badRequest } from './http.js';
import { cleanFileName, extOf } from './schematics.js';

/**
 * 校验并保存一个教程资料附件，返回挂帖所需的数据。
 * @param {Buffer} buffer
 * @param {{ userId: number, fileName: string }} options
 */
export function saveAttachmentFile(buffer, { userId, fileName }) {
  if (!buffer || buffer.length === 0) throw badRequest('附件是空的');

  const name = cleanFileName(fileName);
  const ext = extOf(name);
  if (!ext || !config.attachmentExts.includes(ext)) {
    throw badRequest(
      `只接受这些格式的附件：${config.attachmentExts.map((item) => '.' + item).join(' / ')}`,
      'attachment_ext_invalid',
    );
  }
  if (buffer.length > config.maxFileBytes) {
    throw badRequest(
      `附件太大了，请控制在 ${Math.round(config.maxFileBytes / 1024 / 1024)} MB 以内`,
      'attachment_too_large',
    );
  }

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const base = `att-${userId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const storedName = `${base}.${ext}`;
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadDir, storedName), buffer);

  const inserted = db
    .prepare(
      `INSERT INTO uploads (user_id, url, thumb, mime, width, height, size, kind, meta, created_at)
       VALUES (?, ?, NULL, ?, 0, 0, ?, 'file', ?, ?)`,
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
