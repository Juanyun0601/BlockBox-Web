/**
 * 人机验证：滑块拼图。
 *
 * 服务端现场画一张风景图，抠出一个拼图形状的缺口，再单独切出那块拼图。
 * 用户把拼图拖到缺口上，前端回报「拼图左边的位置」，服务端跟正确答案比一下，
 * 差得不多就算过，并签发一个短期令牌（网页端放 Cookie，启动器放请求头）。
 *
 * 图片全部由代码画出来，不依赖任何素材文件，也不调用第三方服务。
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { encodePng } from './png.js';

// ---------------------------------------------------------------- 参数

const CANVAS_W = 320;
const CANVAS_H = 180;
const PIECE_SIZE = 56;
const TAB_RATIO = 0.23; // 凸起半径 / 拼图边长
const TOLERANCE = 8; // 允许的横向误差（像素）
const CHALLENGE_TTL_MS = 3 * 60 * 1000;
const MAX_PENDING = 2000;
/** 人机验证令牌的 Cookie 名（启动器用 X-Human-Token 请求头传同一个值） */
export const HUMAN_COOKIE = 'bbf_hv';

// ---------------------------------------------------------------- 令牌

let fallbackSecret = null;

function tokenSecret() {
  if (config.humanCheck.secret) return config.humanCheck.secret;
  if (!fallbackSecret) {
    fallbackSecret = crypto.randomBytes(32).toString('hex');
    console.log('[论坛] 没配置 HUMAN_CHECK_SECRET：人机验证令牌只在本次运行内有效，重启后要重新验证。');
  }
  return fallbackSecret;
}

function sign(payload) {
  return crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url').slice(0, 32);
}

/** 签发令牌，格式为「过期时间.签名」，过期时间是秒级时间戳 */
function issueToken() {
  const ttlMs = config.humanCheck.ttlHours * 3600 * 1000;
  const expires = Math.floor((Date.now() + ttlMs) / 1000);
  return { token: `${expires}.${sign(`v1.${expires}`)}`, expires };
}

/** 校验令牌：签名对得上、且还没过期 */
export function tokenValid(raw) {
  const value = String(raw || '');
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const expires = Number(value.slice(0, dot));
  if (!Number.isFinite(expires) || expires * 1000 <= Date.now()) return false;
  const expected = sign(`v1.${expires}`);
  const given = value.slice(dot + 1);
  if (given.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** 请求方是否已经通过人机验证（Cookie 或请求头任一带了有效令牌） */
export function isVerified(cookies = {}, headers = {}) {
  if (!config.humanCheck.enabled) return true;
  const header = String(headers['x-human-token'] || '');
  return tokenValid(cookies[HUMAN_COOKIE]) || tokenValid(header);
}

// ---------------------------------------------------------------- 画布

function createCanvas(width, height) {
  return { width, height, data: new Float32Array(width * height * 4) };
}

function makeRandom(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function blendPixel(canvas, x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height || alpha <= 0) return;
  const i = (y * canvas.width + x) * 4;
  const d = canvas.data;
  const a = Math.min(1, alpha);
  d[i] = d[i] * (1 - a) + color[0] * a;
  d[i + 1] = d[i + 1] * (1 - a) + color[1] * a;
  d[i + 2] = d[i + 2] * (1 - a) + color[2] * a;
  d[i + 3] = d[i + 3] * (1 - a) + 255 * a;
}

/** 柔光圆斑：越靠近圆心越亮，用来做太阳 / 光晕 / 散景 */
function radialGlow(canvas, cx, cy, radius, color, strength) {
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(canvas.width - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(canvas.height - 1, Math.ceil(cy + radius));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = (x - cx) / radius;
      const dy = (y - cy) / radius;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= 1) continue;
      const falloff = (1 - dist) * (1 - dist);
      blendPixel(canvas, x, y, color, falloff * strength);
    }
  }
}

/** 多边形填充（扫描线），山脊、地面都用它 */
function fillPolygon(canvas, points, color, alpha = 1) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minY = Math.min(minY, point[1]);
    maxY = Math.max(maxY, point[1]);
  }
  const from = Math.max(0, Math.floor(minY));
  const to = Math.min(canvas.height - 1, Math.ceil(maxY));
  for (let y = from; y <= to; y += 1) {
    const crossings = [];
    for (let i = 0; i < points.length; i += 1) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const startX = Math.max(0, Math.ceil(crossings[i]));
      const endX = Math.min(canvas.width - 1, Math.floor(crossings[i + 1]));
      for (let x = startX; x <= endX; x += 1) blendPixel(canvas, x, y, color, alpha);
    }
  }
}

function toRgba(canvas) {
  const out = new Uint8Array(canvas.width * canvas.height * 4);
  for (let i = 0; i < out.length; i += 1) {
    const value = canvas.data[i];
    out[i] = value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
  }
  return out;
}

// ---------------------------------------------------------------- 风景图

/** 几套配色：日出 / 晴天 / 黄昏 / 林间 / 夜色，每张验证码随机挑一套 */
const PALETTES = [
  {
    sky: [[34, 52, 104], [248, 172, 126]],
    sun: [255, 226, 168],
    hills: [[84, 68, 106], [62, 50, 86], [40, 32, 60]],
    ground: [[64, 52, 72], [40, 32, 48]],
  },
  {
    sky: [[64, 136, 212], [192, 226, 246]],
    sun: [255, 248, 220],
    hills: [[104, 152, 126], [74, 120, 100], [50, 92, 78]],
    ground: [[92, 126, 88], [58, 92, 62]],
  },
  {
    sky: [[54, 40, 92], [236, 138, 108]],
    sun: [255, 208, 142],
    hills: [[78, 58, 92], [56, 42, 70], [34, 26, 46]],
    ground: [[68, 50, 62], [42, 30, 40]],
  },
  {
    sky: [[118, 172, 146], [216, 234, 200]],
    sun: [248, 252, 218],
    hills: [[80, 122, 92], [58, 96, 72], [38, 72, 56]],
    ground: [[62, 96, 64], [40, 68, 46]],
  },
  {
    sky: [[10, 18, 42], [46, 66, 102]],
    sun: [236, 242, 255],
    hills: [[28, 36, 62], [20, 26, 46], [12, 16, 32]],
    ground: [[22, 28, 44], [12, 16, 26]],
  },
];

function paintScene(canvas, rand) {
  const palette = PALETTES[Math.floor(rand() * PALETTES.length) % PALETTES.length];
  const { width, height } = canvas;
  const horizon = Math.round(height * (0.52 + rand() * 0.1));

  // 天空：竖直渐变 + 一点点横向偏色，看着不那么像纯色块
  for (let y = 0; y < height; y += 1) {
    const t = Math.min(1, y / Math.max(1, horizon));
    const color = [
      palette.sky[0][0] + (palette.sky[1][0] - palette.sky[0][0]) * t,
      palette.sky[0][1] + (palette.sky[1][1] - palette.sky[0][1]) * t,
      palette.sky[0][2] + (palette.sky[1][2] - palette.sky[0][2]) * t,
    ];
    for (let x = 0; x < width; x += 1) {
      const shift = Math.sin((x / width) * Math.PI) * 6;
      blendPixel(canvas, x, y, [color[0] + shift, color[1] + shift, color[2] + shift], 1);
    }
  }

  // 太阳 / 月亮：一团光晕，外面再罩一层更大更淡的
  const sunX = Math.round(width * (0.15 + rand() * 0.7));
  const sunY = Math.round(horizon * (0.2 + rand() * 0.45));
  radialGlow(canvas, sunX, sunY, 64, palette.sun, 0.34);
  radialGlow(canvas, sunX, sunY, 22, palette.sun, 0.9);

  // 云：几条横向拉长的柔光，随机散布在地平线以上
  const clouds = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < clouds; i += 1) {
    const cx = rand() * width;
    const cy = rand() * horizon * 0.85;
    const radius = 26 + rand() * 40;
    radialGlow(canvas, cx, cy, radius, [255, 255, 255], 0.16 + rand() * 0.12);
  }

  // 远近三层山脊：越靠前越暗、起伏越小
  for (let layer = 0; layer < palette.hills.length; layer += 1) {
    const baseY = horizon - (palette.hills.length - 1 - layer) * 14;
    const roughness = 34 - layer * 8;
    const steps = 4 + Math.floor(rand() * 4);
    const ridge = [];
    for (let i = 0; i <= steps; i += 1) {
      const x = (width / steps) * i;
      const y = baseY - rand() * roughness - (i % 2 === 0 ? roughness * 0.35 : 0);
      ridge.push([x, y]);
    }
    fillPolygon(
      canvas,
      [...ridge, [width + 8, height + 8], [-8, height + 8]],
      palette.hills[layer],
      1,
    );
  }

  // 地面：地平线往下压暗，让底部比天空更沉
  const groundTop = horizon + 6;
  for (let y = groundTop; y < height; y += 1) {
    const t = (y - groundTop) / Math.max(1, height - groundTop);
    const color = [
      palette.ground[0][0] + (palette.ground[1][0] - palette.ground[0][0]) * t,
      palette.ground[0][1] + (palette.ground[1][1] - palette.ground[0][1]) * t,
      palette.ground[0][2] + (palette.ground[1][2] - palette.ground[0][2]) * t,
    ];
    const wobble = Math.sin((y / height) * 9) * 3;
    for (let x = 0; x < width; x += 1) {
      blendPixel(canvas, x, y, [color[0] + wobble, color[1] + wobble, color[2] + wobble], 1);
    }
  }

  // 散景光点：给画面加点细节，拼图切下来才有东西可看
  const blobs = 5 + Math.floor(rand() * 5);
  for (let i = 0; i < blobs; i += 1) {
    const color = palette.sun.map((value) => Math.min(255, value * (0.8 + rand() * 0.4)));
    radialGlow(canvas, rand() * width, rand() * height, 8 + rand() * 26, color, 0.2 + rand() * 0.3);
  }

  // 轻噪点：让纯渐变别太平，幅度压小一点，PNG 才不会大得离谱
  for (let i = 0; i < canvas.data.length; i += 4) {
    const noise = (rand() - 0.5) * 3;
    canvas.data[i] += noise;
    canvas.data[i + 1] += noise;
    canvas.data[i + 2] += noise;
  }
}

// ---------------------------------------------------------------- 拼图

/** 拼图形状：圆角方块 + 右边一个凸起 + 上边一个凹槽 */
function buildMask() {
  const size = PIECE_SIZE;
  const radius = size * TAB_RATIO;
  const pad = Math.ceil(radius) + 3;
  const span = size + pad * 2;
  const mask = new Uint8Array(span * span);
  const corner = size * 0.16;

  for (let y = 0; y < span; y += 1) {
    for (let x = 0; x < span; x += 1) {
      const u = x - pad;
      const v = y - pad;
      let inside = false;

      // 圆角矩形本体
      if (u >= 0 && u < size && v >= 0 && v < size) {
        const cx = Math.min(Math.max(u, corner), size - corner);
        const cy = Math.min(Math.max(v, corner), size - corner);
        const dx = u - cx;
        const dy = v - cy;
        inside = dx * dx + dy * dy <= corner * corner + 0.01;
      }
      // 右侧凸起
      if (!inside) {
        const dx = u - size;
        const dy = v - size / 2;
        inside = dx * dx + dy * dy <= radius * radius;
      }
      // 顶部凹槽（挖掉一块）
      if (inside) {
        const dx = u - size / 2;
        const dy = v;
        if (dx * dx + dy * dy <= radius * radius) inside = false;
      }
      mask[y * span + x] = inside ? 1 : 0;
    }
  }
  return { mask, span, pad, size };
}

/** 在画布上抠掉一块：压暗 + 偏冷，看着像被挖走 */
function punchHole(canvas, shape, holeX, holeY) {
  const { mask, span, pad } = shape;
  for (let y = 0; y < span; y += 1) {
    for (let x = 0; x < span; x += 1) {
      if (!mask[y * span + x]) continue;
      const px = holeX + x - pad;
      const py = holeY + y - pad;
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
      const i = (py * canvas.width + px) * 4;
      const d = canvas.data;
      d[i] = d[i] * 0.34 + 12;
      d[i + 1] = d[i + 1] * 0.38 + 18;
      d[i + 2] = d[i + 2] * 0.46 + 30;
    }
  }

  // 缺口边缘描一圈浅色：夜景那种很暗的画面里，只压暗的话人眼几乎找不到缺口
  const at = (x, y) => (x < 0 || y < 0 || x >= span || y >= span ? 0 : mask[y * span + x]);
  for (let y = 0; y < span; y += 1) {
    for (let x = 0; x < span; x += 1) {
      if (!mask[y * span + x]) continue;
      const boundary =
        at(x - 1, y) === 0 || at(x + 1, y) === 0 || at(x, y - 1) === 0 || at(x, y + 1) === 0;
      if (!boundary) continue;
      blendPixel(canvas, holeX + x - pad, holeY + y - pad, [236, 240, 248], 0.42);
    }
  }
}

/** 从缺口处把拼图切下来，带一圈浅色描边和一点投影 */
function extractPiece(canvas, shape, holeX, holeY) {
  const { mask, span, pad } = shape;
  const out = new Uint8Array(span * span * 4);
  const d = canvas.data;

  const at = (x, y) => (x < 0 || y < 0 || x >= span || y >= span ? 0 : mask[y * span + x]);

  for (let y = 0; y < span; y += 1) {
    for (let x = 0; x < span; x += 1) {
      if (!mask[y * span + x]) continue;
      const px = Math.min(canvas.width - 1, Math.max(0, holeX + x - pad));
      const py = Math.min(canvas.height - 1, Math.max(0, holeY + y - pad));
      const src = (py * canvas.width + px) * 4;
      const i = (y * span + x) * 4;

      // 投影：往右下错开几个像素，压在背景上不显得贴纸一样平
      const shadowX = x + 2;
      const shadowY = y + 3;
      if (at(shadowX, shadowY) === 0) {
        const s = (shadowY * span + shadowX) * 4;
        if (out[s + 3] === 0) {
          out[s] = 8;
          out[s + 1] = 10;
          out[s + 2] = 12;
          out[s + 3] = 96;
        }
      }

      const edge = at(x - 1, y) === 0 || at(x + 1, y) === 0 || at(x, y - 1) === 0 || at(x, y + 1) === 0;
      const mix = edge ? 0.62 : 0;
      out[i] = d[src] * (1 - mix) + 255 * mix;
      out[i + 1] = d[src + 1] * (1 - mix) + 255 * mix;
      out[i + 2] = d[src + 2] * (1 - mix) + 255 * mix;
      out[i + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 挑战

/** id -> { x, expires, createdAt } */
const pending = new Map();

function purge() {
  const now = Date.now();
  for (const [id, item] of pending) {
    if (item.expires <= now) pending.delete(id);
  }
  // 兜底：内存里最多留这么多个，超了就从最老的开始丢
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value;
    pending.delete(oldest);
  }
}

const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;

/**
 * 生成一道验证题：返回背景图、拼图、拼图的起始位置。
 * 正确答案只留在服务端，前端拿不到。
 */
export function issueChallenge() {
  purge();
  const rand = makeRandom(crypto.randomInt(0, 0xffffffff));
  const canvas = createCanvas(CANVAS_W, CANVAS_H);
  paintScene(canvas, rand);

  const shape = buildMask();
  // 缺口位置：横向别贴着左边（贴边一眼就能猜出来），但整块拼图要能塞进画面
  const minX = Math.round(shape.size * 0.9);
  const maxX = CANVAS_W - shape.size - shape.pad;
  const holeX = Math.round(minX + rand() * Math.max(1, maxX - minX));
  // 纵向留出整块拼图，上下都不越界
  const holeY = Math.round(
    shape.pad + 2 + rand() * Math.max(1, CANVAS_H - shape.span - 4),
  );

  // 先把拼图从原图上切下来（切的是没抠洞的画面），再在背景上挖洞
  const pieceData = extractPiece(canvas, shape, holeX, holeY);
  punchHole(canvas, shape, holeX, holeY);

  const bgPng = encodePng({ width: CANVAS_W, height: CANVAS_H, data: toRgba(canvas) });
  const piecePng = encodePng({
    width: shape.span,
    height: shape.span,
    data: pieceData,
  });

  const id = crypto.randomBytes(12).toString('base64url');
  pending.set(id, { x: holeX, expires: Date.now() + CHALLENGE_TTL_MS, createdAt: Date.now() });

  return {
    id,
    width: CANVAS_W,
    height: CANVAS_H,
    tolerance: TOLERANCE,
    ttl: Math.round(CHALLENGE_TTL_MS / 1000),
    ttl_hours: config.humanCheck.ttlHours,
    piece: {
      w: shape.span,
      h: shape.span,
      pad: shape.pad,
      size: shape.size,
      top: holeY - shape.pad,
    },
    bg: dataUrl(bgPng),
    piece_img: dataUrl(piecePng),
  };
}

/**
 * 核对答案：answer 是拼图左边的位置（相对画布左边，像素）。
 * 一次性：不管对错这道题都作废，错了就重新拿一道。
 */
export function verifyAnswer({ id, answer, duration }) {
  const key = String(id || '');
  const record = pending.get(key);
  if (!record) {
    return { ok: false, reason: 'expired', message: '验证已过期，请重新拖动滑块' };
  }
  pending.delete(key);

  if (record.expires <= Date.now()) {
    return { ok: false, reason: 'expired', message: '验证已过期，请重新拖动滑块' };
  }

  const value = Number(answer);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: 'invalid', message: '没收到滑块位置，请重新拖动' };
  }
  if (Math.abs(value - record.x) > TOLERANCE) {
    return { ok: false, reason: 'wrong', message: '拼图没对准缺口，再试一次' };
  }

  // 拖得比眨眼还快，基本是脚本
  const ms = Number(duration);
  if (Number.isFinite(ms) && ms > 0 && ms < 120) {
    return { ok: false, reason: 'pace', message: '手速快得不像真人，请再拖一次' };
  }

  const { token, expires } = issueToken();
  return { ok: true, token, expires };
}

/** 免验还有多少秒（0 表示需要验证） */
export function remainingSeconds(raw) {
  const value = String(raw || '');
  const dot = value.indexOf('.');
  if (!tokenValid(value)) return 0;
  return Math.max(0, Math.round(Number(value.slice(0, dot)) - Date.now() / 1000));
}

// -------------------------------------------------------------- 下载直链令牌
//
// 版本安装包的下载默认要走人机验证（防脚本刷量/盗链），但启动器的应用内更新
// 没法弹滑块。给它发「绑定到具体文件的短时效签名」：检查更新时从
// /api/app/releases 拿到带令牌的直链，下载时凭令牌放行，不需要任何人工操作。
// 令牌格式与人机令牌同形：<过期秒级时间戳>.<签名前32位>，签名内容绑定版本+文件名。

/** 签发一个绑定 <version>/<filename> 的下载令牌，默认 24 小时有效 */
export function signDownloadToken(version, filename, ttlSeconds = 24 * 3600) {
  const expires = Math.floor(Date.now() / 1000) + Math.max(60, Math.floor(ttlSeconds));
  return { token: `${expires}.${sign(`dl1.${version}/${filename}.${expires}`)}`, expires };
}

/** 校验下载令牌：签名必须对得上版本+文件名，且未过期 */
export function verifyDownloadToken(version, filename, raw) {
  const value = String(raw || '');
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const expires = Number(value.slice(0, dot));
  if (!Number.isFinite(expires) || expires * 1000 <= Date.now()) return false;
  const expected = sign(`dl1.${version}/${filename}.${expires}`);
  const given = value.slice(dot + 1);
  if (given.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  } catch {
    return false;
  }
}
