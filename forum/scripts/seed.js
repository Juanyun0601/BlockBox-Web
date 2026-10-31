/**
 * 造点假数据，方便本地看效果：
 *   npm run seed            只建一个管理员账号 admin
 *   npm run seed -- --demo  额外生成几个测试用户和主题
 */
import { db, now, refreshBoardCounts } from '../server/db.js';
import { hashPassword } from '../server/lib/auth.js';

const demo = process.argv.includes('--demo');
const timestamp = now();

function ensureUser(name, password, role = 'user') {
  const existing = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(name);
  if (existing) return existing;
  const result = db
    .prepare(
      `INSERT INTO users (username, display_name, pass_hash, role, bio, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(name, name, hashPassword(password), role, '', timestamp, timestamp);
  return { id: Number(result.lastInsertRowid), username: name };
}

const admin = ensureUser('admin', 'admin123', 'admin');
console.log(`管理员：${admin.username} / admin123（请登录后改密码）`);

if (!demo) {
  console.log('提示：加 --demo 参数可以顺带生成演示帖子。');
  process.exit(0);
}

const boards = db.prepare('SELECT id, slug FROM boards').all();
const boardId = (slug) => boards.find((board) => board.slug === slug)?.id || boards[0].id;

const users = [
  ensureUser('小白玩家', 'demo1234'),
  ensureUser('红石工程师', 'demo1234'),
  ensureUser('整合包爱好者', 'demo1234'),
];

const threads = [
  {
    board: 'help',
    author: 0,
    title: '启动器提示找不到 Java，要怎么设置？',
    content:
      '我在官网下载了最新版，双击启动后弹出「未检测到 Java 运行环境」。\n\n电脑里其实装了 JDK 17，路径是 `D:\\Java\\jdk-17`。\n\n> 设置里那个「Java 路径」应该填到哪一层？填到 bin 还是 jdk 根目录？',
  },
  {
    board: 'guide',
    author: 1,
    title: '给低配电脑的方块盒子设置经验（4G 内存也能跑）',
    content:
      '这几项调完，我在老笔记本上帧数从 40 提到了 70 左右：\n\n- 内存配额 `-Xmx2G` 就够，别给太多\n- 关闭高级 OpenGL，改用兼容模式\n- 渲染距离 8 格\n- 关闭平滑光照\n\n**注意**：整合包不要低于 3G，不然会频繁 GC。',
  },
  {
    board: 'plugin',
    author: 2,
    title: '插件开发文档里的示例代码能直接跑吗？',
    content:
      '文档说插件用 JSON 声明，然后调用几个 API。\n\n我照着写了一个最小插件，`mainfest.json` 里字段名不太确定，有人成功跑起来过吗？求个可用的模板。',
  },
];

for (const item of threads) {
  const author = users[item.author];
  const inserted = db
    .prepare(
      `INSERT INTO threads (board_id, author_id, title, created_at, last_post_at, last_post_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(boardId(item.board), author.id, item.title, timestamp, timestamp, author.id);
  const threadId = Number(inserted.lastInsertRowid);
  db.prepare(
    `INSERT INTO posts (thread_id, author_id, floor, content, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?)`,
  ).run(threadId, author.id, item.content, timestamp, timestamp);
  db.prepare('UPDATE users SET thread_count = thread_count + 1, post_count = post_count + 1 WHERE id = ?').run(
    author.id,
  );
  db.prepare(
    `INSERT INTO thread_search (thread_id, board_id, title, body, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(threadId, boardId(item.board), item.title, item.content, timestamp);
}

for (const board of boards) refreshBoardCounts(board.id);
console.log(`已生成 ${threads.length} 个演示主题，测试账号密码都是 demo1234。`);
