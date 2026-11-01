import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { badRequest } from './http.js';
import { decodePng, encodePng, fitSize, isPng, resizeRgba } from './png.js';

/** 支持的四类图片，靠文件头判断真实类型，不信任客户端给的 content-type */
const SIGNATURES = [
  {
    ext: 'png',
    mime: 'image/png',
    match: (buf) => buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
  },
  {
    ext: 'jpg',
    mime: 'image/jpeg',
    match: (buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    ext: 'gif',
    mime: 'image/gif',
    match: (buf) =>
      buf.length > 6 &&
      (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a'),
  },
  {
    ext: 'webp',
    mime: 'image/webp',
    match: (buf) =>
      buf.length > 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

export function detectImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  return SIGNATURES.find((signature) => signature.match(buffer)) || null;
}

// ------------------------------------------------------------ sharp（可选）

let sharpModule = null;
let sharpChecked = false;

/**
 * sharp 不是必需依赖：装了就能压缩 JPEG/WebP/GIF 并生成缩略图，
 * 没装就只用内置的 PNG 处理。首次调用时才尝试加载。
 */
export async function getSharp() {
  if (!sharpChecked) {
    sharpChecked = true;
    try {
      const imported = await import('sharp');
      sharpModule = imported.default || imported;
    } catch {
      sharpModule = null;
    }
  }
  return sharpModule;
}

export async function imageEngine() {
  return (await getSharp()) ? 'sharp' : 'builtin-png';
}

async function processWithSharp(sharp, buffer, { isAvatar, isCover, maxDimension, thumbSize }) {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  const sourceWidth = meta.width || 0;
  const sourceHeight = meta.height || 0;
  const target = fitSize(sourceWidth, sourceHeight, maxDimension);
  const format = meta.format;

  let pipeline = sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: target.width, height: target.height, fit: 'inside', withoutEnlargement: true });

  if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true, progressive: true });
  else if (format === 'png') pipeline = pipeline.png({ compressionLevel: 9, palette: true });
  else if (format === 'webp') pipeline = pipeline.webp({ quality: 82 });
  else if (format === 'gif') pipeline = pipeline.gif();

  const encoded = await pipeline.toBuffer();
  const resized = target.width !== sourceWidth || target.height !== sourceHeight;
  // 超过长边上限时以"缩到上限内"为准；没超限就只在体积确实变小时才替换原图
  const useEncoded = resized || isAvatar || isCover || encoded.length < buffer.length;

  const thumbTarget = fitSize(sourceWidth, sourceHeight, thumbSize);
  let thumbBuffer = null;
  if (thumbSize > 0 && (thumbTarget.width < sourceWidth || thumbTarget.height < sourceHeight)) {
    thumbBuffer = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: thumbTarget.width, height: thumbTarget.height, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true })
      .toBuffer();
  }

  return {
    buffer: useEncoded ? encoded : buffer,
    thumbBuffer,
    thumbExt: thumbBuffer ? 'jpg' : null,
    width: useEncoded ? target.width : sourceWidth,
    height: useEncoded ? target.height : sourceHeight,
    optimized: useEncoded && encoded.length < buffer.length,
    engine: 'sharp',
  };
}

// ------------------------------------------------------------ 内置 PNG 处理

function processBuiltinPng(buffer, { isAvatar, isCover, maxDimension, thumbSize }) {
  const decoded = decodePng(buffer);
  if (!decoded) return null;

  const { width: sourceWidth, height: sourceHeight, data } = decoded;
  const target = fitSize(sourceWidth, sourceHeight, maxDimension);

  let output = buffer;
  let width = sourceWidth;
  let height = sourceHeight;
  let optimized = false;

  if (target.width !== sourceWidth || target.height !== sourceHeight) {
    const resized = resizeRgba(data, sourceWidth, sourceHeight, target.width, target.height);
    const encoded = encodePng({ width: target.width, height: target.height, data: resized });
    // 超限一律缩到上限内（这是硬上限，不是"尽量优化"）
    output = encoded;
    width = target.width;
    height = target.height;
    optimized = encoded.length < buffer.length;
  } else if ((isAvatar || isCover) && buffer.length > 128 * 1024) {
    // 头像 / 封面在尺寸内但文件特别大时，重压一遍
    const encoded = encodePng({ width: sourceWidth, height: sourceHeight, data });
    if (encoded.length < buffer.length) {
      output = encoded;
      optimized = true;
    }
  }

  const thumbTarget = fitSize(sourceWidth, sourceHeight, thumbSize);
  let thumbBuffer = null;
  if (thumbSize > 0 && (thumbTarget.width < sourceWidth || thumbTarget.height < sourceHeight)) {
    const thumbData = resizeRgba(data, sourceWidth, sourceHeight, thumbTarget.width, thumbTarget.height);
    thumbBuffer = encodePng({ width: thumbTarget.width, height: thumbTarget.height, data: thumbData });
  }

  return {
    buffer: output,
    thumbBuffer,
    thumbExt: thumbBuffer ? 'png' : null,
    width,
    height,
    optimized,
    engine: 'builtin-png',
  };
}

/**
 * 处理一张图片：压缩原图（超过上限才缩）、生成缩略图。
 * 返回 { buffer, thumbBuffer, width, height, optimized, engine }。
 */
export async function processImage(buffer, { kind = 'img' } = {}) {
  const isAvatar = kind === 'avatar';
  const isCover = kind === 'cover';
  const options = {
    isAvatar,
    isCover,
    maxDimension: isAvatar
      ? config.avatarSize
      : isCover
        ? config.coverMaxDimension
        : config.imageMaxDimension,
    // 头像 / 封面用不到缩略图，传 0 让处理流程跳过
    thumbSize: isAvatar || isCover ? 0 : config.thumbSize,
  };

  const sharp = await getSharp();
  if (sharp) {
    try {
      return await processWithSharp(sharp, buffer, options);
    } catch (error) {
      console.warn('[论坛] sharp 处理失败，改用内置处理：', error.message);
    }
  }

  if (isPng(buffer)) {
    const result = processBuiltinPng(buffer, options);
    if (result) return result;
  }

  return {
    buffer,
    thumbBuffer: null,
    thumbExt: null,
    width: 0,
    height: 0,
    optimized: false,
    engine: 'none',
  };
}

// ------------------------------------------------------------ 落盘

/**
 * 校验并保存一张图片，返回可直接放进 <img src> 的站内路径。
 * kind 决定文件名前缀与处理规格（avatar 头像 / cover 主页封面 / img 帖子配图）。
 */
export async function saveImage(buffer, { userId, kind = 'img', maxBytes = config.maxImageBytes } = {}) {
  if (!buffer || buffer.length < 16) throw badRequest('图片内容为空');
  if (buffer.length > maxBytes) {
    throw badRequest(`图片太大了，请压缩到 ${Math.round(maxBytes / 1024 / 1024)} MB 以内`, 'image_too_large');
  }
  const detected = detectImage(buffer);
  if (!detected) throw badRequest('只支持 PNG / JPG / WebP / GIF 图片', 'image_type');

  const processed = await processImage(buffer, { kind });

  const base = `${kind}-${userId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const filename = `${base}.${detected.ext}`;
  const thumbsDir = path.join(config.uploadDir, 'thumbs');
  fs.mkdirSync(config.uploadDir, { recursive: true });

  await fs.promises.writeFile(path.join(config.uploadDir, filename), processed.buffer);

  let thumbUrl = null;
  if (kind === 'img' && processed.thumbBuffer && processed.thumbExt) {
    fs.mkdirSync(thumbsDir, { recursive: true });
    const thumbName = `${base}.${processed.thumbExt}`;
    await fs.promises.writeFile(path.join(thumbsDir, thumbName), processed.thumbBuffer);
    thumbUrl = `/uploads/thumbs/${thumbName}`;
  }

  const inserted = db
    .prepare(
      `INSERT INTO uploads (user_id, url, thumb, mime, width, height, size, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      `/uploads/${filename}`,
      thumbUrl,
      detected.mime,
      processed.width,
      processed.height,
      processed.buffer.length,
      kind,
      now(),
    );

  return {
    id: Number(inserted.lastInsertRowid),
    url: `/uploads/${filename}`,
    thumb: thumbUrl,
    width: processed.width,
    height: processed.height,
    size: processed.buffer.length,
    original_size: buffer.length,
    optimized: processed.optimized,
    engine: processed.engine,
    mime: detected.mime,
  };
}

/** 只允许删 uploads 目录下的文件（原图和对应缩略图一起删） */
export function removeUpload(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  const root = path.resolve(config.uploadDir) + path.sep;
  const name = path.basename(url);
  const target = path.join(config.uploadDir, name);
  if (target.startsWith(root)) fs.promises.unlink(target).catch(() => {});

  const thumbsDir = path.join(config.uploadDir, 'thumbs');
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  const stems = [base];
  for (const stem of stems) {
    for (const ext of ['png', 'jpg', 'webp']) {
      const thumb = path.join(thumbsDir, `${stem}.${ext}`);
      if (thumb.startsWith(root)) fs.promises.unlink(thumb).catch(() => {});
    }
  }
}
