import crypto from 'node:crypto';
import { db, now, transaction } from '../db.js';

/**
 * 邮箱验证码：只存哈希不存明文，一封邮箱同时只有一份有效码，
 * 重发即覆盖。校验通过后立即作废，错误次数超限也要重新发。
 */

export const EMAIL_CODE_TTL = 10 * 60; // 有效期（秒）
export const EMAIL_CODE_MAX_ATTEMPTS = 5; // 一份验证码最多允许输错的次数

const normalize = (email) => email.trim().toLowerCase();
const codeHash = (email, code) =>
  crypto.createHash('sha256').update(`${normalize(email)}|${code}`).digest('hex');

/** 生成 6 位数字码并覆盖旧码，返回 { code, expiresIn } */
export function issueEmailCode(email) {
  const code = String(crypto.randomInt(100000, 1000000));
  const timestamp = now();
  transaction(() => {
    db.prepare(
      `INSERT INTO email_codes (email, code_hash, expires_at, attempts, created_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(email) DO UPDATE SET
         code_hash = excluded.code_hash,
         expires_at = excluded.expires_at,
         attempts = 0,
         created_at = excluded.created_at`,
    ).run(normalize(email), codeHash(email, code), timestamp + EMAIL_CODE_TTL, timestamp);
  });
  return { code, expiresIn: EMAIL_CODE_TTL };
}

/**
 * 校验验证码：成功就作废并返回 { ok: true }，
 * 失败返回 { ok: false, message }，message 可直接展示给用户。
 */
export function consumeEmailCode(email, code) {
  const key = normalize(email);
  const row = db.prepare('SELECT * FROM email_codes WHERE email = ?').get(key);
  if (!row || row.expires_at <= now()) {
    db.prepare('DELETE FROM email_codes WHERE email = ?').run(key);
    return { ok: false, message: '验证码已过期，请重新发送' };
  }
  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    db.prepare('DELETE FROM email_codes WHERE email = ?').run(key);
    return { ok: false, message: '错误次数太多，请重新发送验证码' };
  }
  if (row.code_hash !== codeHash(email, String(code || ''))) {
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').run(key);
    const left = EMAIL_CODE_MAX_ATTEMPTS - row.attempts - 1;
    return { ok: false, message: left > 0 ? `验证码不正确，还能再试 ${left} 次` : '验证码不正确，请重新发送' };
  }
  db.prepare('DELETE FROM email_codes WHERE email = ?').run(key);
  return { ok: true };
}

/** 清理过期验证码（挂在启动与定时任务里跑） */
export function purgeExpiredEmailCodes() {
  db.prepare('DELETE FROM email_codes WHERE expires_at <= ?').run(now());
}
