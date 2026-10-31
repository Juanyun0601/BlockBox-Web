/**
 * 纯 JS 的 PNG 处理：解码 → 缩放 → 重新编码。
 * 只支持 8 位、非隔行的 RGB / RGBA / 灰度（覆盖截图和大部分导出图）。
 * 遇到不支持的格式返回 null，上层原样保存，不影响上传。
 */
import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ------------------------------------------------------------ CRC32

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ------------------------------------------------------------ 解码

/** 读 IHDR，不解像素，用于快速判断尺寸 */
export function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function decodePng(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;

  let offset = 8;
  let header = null;
  const dataChunks = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;

    if (type === 'IHDR') {
      header = {
        width: buffer.readUInt32BE(dataStart),
        height: buffer.readUInt32BE(dataStart + 4),
        bitDepth: buffer[dataStart + 8],
        colorType: buffer[dataStart + 9],
        interlace: buffer[dataStart + 12],
      };
    } else if (type === 'IDAT') {
      dataChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!header || dataChunks.length === 0) return null;
  if (header.bitDepth !== 8 || header.interlace !== 0) return null;

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType];
  if (!channels) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(dataChunks));
  } catch {
    return null;
  }

  const stride = header.width * channels;
  if (raw.length < stride * header.height + header.height) return null;

  const pixels = Buffer.alloc(stride * header.height);
  let position = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[position];
    position += 1;
    const row = raw.subarray(position, position + stride);
    position += stride;
    const current = pixels.subarray(y * stride, (y + 1) * stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) return null;
      current[x] = value & 0xff;
    }
    previous = current;
  }

  const data = Buffer.alloc(header.width * header.height * 4);
  for (let i = 0; i < header.width * header.height; i += 1) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 4) {
      data[d] = pixels[s];
      data[d + 1] = pixels[s + 1];
      data[d + 2] = pixels[s + 2];
      data[d + 3] = pixels[s + 3];
    } else if (channels === 3) {
      data[d] = pixels[s];
      data[d + 1] = pixels[s + 1];
      data[d + 2] = pixels[s + 2];
      data[d + 3] = 255;
    } else if (channels === 2) {
      data[d] = pixels[s];
      data[d + 1] = pixels[s];
      data[d + 2] = pixels[s];
      data[d + 3] = pixels[s + 1];
    } else {
      data[d] = pixels[s];
      data[d + 1] = pixels[s];
      data[d + 2] = pixels[s];
      data[d + 3] = 255;
    }
  }

  return { width: header.width, height: header.height, data };
}

// ------------------------------------------------------------ 编码

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** RGBA → PNG（每行在 None / Sub / Up 里挑压缩效果最好的） */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);

  let out = 0;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    let bestFilter = 0;
    let bestScore = Infinity;
    let bestRow = null;

    for (const filter of [0, 1, 2]) {
      const candidate = Buffer.alloc(stride);
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const value = data[rowStart + x];
        const left = x >= 4 ? data[rowStart + x - 4] : 0;
        const up = y > 0 ? data[rowStart - stride + x] : 0;
        let predicted = 0;
        if (filter === 1) predicted = left;
        else if (filter === 2) predicted = up;
        const result = (value - predicted) & 0xff;
        candidate[x] = result;
        score += result < 128 ? result : 256 - result;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        bestRow = candidate;
      }
    }

    filtered[out] = bestFilter;
    out += 1;
    bestRow.copy(filtered, out);
    out += stride;
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const idat = zlib.deflateSync(filtered, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------ 缩放

/** 等比缩放到框内，不放大 */
export function fitSize(width, height, max) {
  if (width <= max && height <= max) return { width, height };
  const ratio = Math.min(max / width, max / height);
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/** 面积平均缩放（预乘 alpha，缩小时透明边缘不会发黑） */
export function resizeRgba(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  const scaleX = sourceWidth / targetWidth;
  const scaleY = sourceHeight / targetHeight;

  for (let y = 0; y < targetHeight; y += 1) {
    const startY = Math.floor(y * scaleY);
    const endY = Math.max(startY + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < targetWidth; x += 1) {
      const startX = Math.floor(x * scaleX);
      const endX = Math.max(startX + 1, Math.floor((x + 1) * scaleX));

      let r = 0;
      let g = 0;
      let b = 0;
      let alphaSum = 0;
      let count = 0;

      for (let sy = startY; sy < endY && sy < sourceHeight; sy += 1) {
        for (let sx = startX; sx < endX && sx < sourceWidth; sx += 1) {
          const index = (sy * sourceWidth + sx) * 4;
          const alpha = source[index + 3] / 255;
          r += source[index] * alpha;
          g += source[index + 1] * alpha;
          b += source[index + 2] * alpha;
          alphaSum += alpha;
          count += 1;
        }
      }

      const target = (y * targetWidth + x) * 4;
      if (alphaSum > 0) {
        output[target] = Math.round(r / alphaSum);
        output[target + 1] = Math.round(g / alphaSum);
        output[target + 2] = Math.round(b / alphaSum);
      }
      output[target + 3] = count > 0 ? Math.round((alphaSum / count) * 255) : 0;
    }
  }

  return output;
}

export function isPng(buffer) {
  return buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}
