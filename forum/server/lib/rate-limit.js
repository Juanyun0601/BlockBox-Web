import { HttpError } from './http.js';

/** key -> { count, resetAt } 的滑动窗口计数器，进程内即可，重启清零无妨 */
const buckets = new Map();

/**
 * 记一次请求。返回 0 表示放行，否则返回需要等待的秒数。
 */
export function hit(key, limit, windowMs) {
  const current = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= current) {
    bucket = { count: 0, resetAt: current + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return Math.max(1, Math.ceil((bucket.resetAt - current) / 1000));
  }
  return 0;
}

/** 超限直接抛 429 */
export function enforce(key, limit, windowMs, label = '操作太频繁') {
  const wait = hit(key, limit, windowMs);
  if (wait) throw new HttpError(429, `${label}，请 ${wait} 秒后再试`, 'rate_limited');
}

export function reset(key) {
  buckets.delete(key);
}

const cleanup = setInterval(() => {
  const current = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= current) buckets.delete(key);
  }
}, 60_000);
cleanup.unref();
