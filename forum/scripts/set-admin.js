import { db, now } from '../db.js';
import { hashPassword } from '../lib/auth.js';

const [name = 'admin', pass = ''] = process.argv.slice(2);
const password = pass || 'bbf-' + Math.random().toString(36).slice(2, 10);
const timestamp = now();

const existing = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(name);
if (existing) {
  db.prepare("UPDATE users SET role = 'admin', pass_hash = ? WHERE id = ?").run(hashPassword(password), existing.id);
  console.log(`已把 ${existing.username} 设为管理员，新密码：${password}`);
} else {
  db.prepare(
    `INSERT INTO users (username, display_name, pass_hash, role, created_at, last_seen_at)
     VALUES (?, ?, ?, 'admin', ?, ?)`,
  ).run(name, name, hashPassword(password), timestamp, timestamp);
  console.log(`已创建管理员 ${name}，密码：${password}`);
}
console.log('请登录后立即在「个人中心」里修改密码。');
