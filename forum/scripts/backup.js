/**
 * 备份数据库与上传的头像：
 *   npm run backup                 → 备份到 data/backups/forum-<时间>.db
 *   node scripts/backup.js 目录    → 备份到指定目录
 *
 * 用 SQLite 的 VACUUM INTO 做一致性快照，不用停服，也不会因为 WAL 少数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, ROOT_DIR } from '../server/config.js';

const targetDir = path.resolve(ROOT_DIR, process.argv[2] || 'data/backups');
fs.mkdirSync(targetDir, { recursive: true });

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..+/, '')
  .replace('T', '-');

const dbTarget = path.join(targetDir, `forum-${stamp}.db`);
const db = new DatabaseSync(config.dbPath, { readOnly: false });
db.exec(`VACUUM INTO '${dbTarget.replace(/'/g, "''")}'`);
db.close();
console.log(`数据库已备份：${dbTarget}（${(fs.statSync(dbTarget).size / 1024).toFixed(0)} KB）`);

// 顺带把上传目录打一份（头像 / 帖子图片）
// 注意：不要用 fs.cpSync，Windows 上 Node 22.19 会直接崩进程（0xC0000409），这里手写递归
function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

const uploadsSource = config.uploadDir;
if (fs.existsSync(uploadsSource)) {
  const uploadTarget = path.join(targetDir, `uploads-${stamp}`);
  try {
    copyDir(uploadsSource, uploadTarget);
    const files = fs.readdirSync(uploadTarget).length;
    console.log(`上传文件已备份：${uploadTarget}（${files} 个文件）`);
  } catch (error) {
    console.error(`上传文件备份失败（数据库备份已完成）：${error.code || ''} ${error.message}`);
  }
}

// 只保留最近 10 份，避免把磁盘塞满
const entries = fs.readdirSync(targetDir, { withFileTypes: true });

const dbBackups = entries
  .filter((entry) => entry.isFile() && entry.name.startsWith('forum-') && entry.name.endsWith('.db'))
  .map((entry) => entry.name)
  .sort()
  .reverse();
for (const old of dbBackups.slice(10)) {
  fs.unlinkSync(path.join(targetDir, old));
  console.log(`已清理旧备份：${old}`);
}

const uploadBackups = entries
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('uploads-'))
  .map((entry) => entry.name)
  .sort()
  .reverse();
for (const old of uploadBackups.slice(10)) {
  fs.rmSync(path.join(targetDir, old), { recursive: true, force: true });
  console.log(`已清理旧上传备份：${old}`);
}
