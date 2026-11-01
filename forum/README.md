# 方块盒子论坛

方块盒子官网的玩家社区后端 + 前端。**零第三方依赖**：只用 Node.js 内置模块（`node:http`、`node:sqlite`、`node:crypto`），
`npm install` 都不用跑，`node server/index.js` 就能用。

- 技术栈：Node.js ≥ 22.5（内置 SQLite）+ 原生 HTML/CSS/JS
- 数据库：单个 SQLite 文件（默认 `data/forum.db`），备份就是复制文件
- 页面：服务端直接托管 `web/`，与官网同一套绿色主题，自带深色模式与手机端适配

## 已经做好的功能

| 模块 | 内容 |
| --- | --- |
| 账号 | 注册 / 登录 / 退出、scrypt 加盐存密码、会话 Cookie（HttpOnly、SameSite）、改密码后其他设备自动下线 |
| 用户中心 | 昵称、简介、邮箱、头像上传（自动裁成圆形显示）、个人主页封面图（拖拽裁成 3:1 横图）、我发过的主题 / 回复 |
| 板块 | 6 个默认板块（综合讨论 / 使用求助 / 教程与分享 / 插件与开发 / 意见建议 / 闲聊灌水），管理员可增删改 |
| 主题 | 发帖、编辑标题、删除、置顶、锁定、换板块、浏览量、按最新回复 / 最新发布 / 最热排序、分页 |
| 回复 | 楼层、楼中楼（回复某层会挂在它下面）、引用、编辑（显示“已编辑”）、删除（保留楼层占位）、锁定后不能回复 |
| 互动 | 每个楼层可点赞；主题可收藏，收藏列表在个人主页；主题最多 4 个标签，按标签筛选和搜索；个人主页能看「我赞过的」和「我的收藏」 |
| 通知 | 有人回复我的主题、回复我的楼层（楼中楼）、或在帖子里 @ 我时进站内通知；同一主题的消息会折叠成一组，顶栏铃铛显示未读数，点进去定位到对应楼层 |
| 图片 | 站内图床：粘贴截图或拖进输入框就上传并插入正文；超过 2560px 自动等比压缩，同时生成 520px 缩略图，正文里先加载缩略图、点开看原图；头像支持拖拽/缩放裁剪；「我的相册」可以统一管理上传过的图片 |
| 举报 | 任意楼层可举报，进入管理后台「审核队列」，可删除该楼层并把举报标记为已处理，或直接忽略 |
| 搜索 | 标题 + 正文 + 标签关键词，中文两个字也能搜，结果带命中片段 |
| 管理后台 | 站点数据、板块增删改、主题置顶 / 锁定 / 删除、用户设为管理员 / 一键禁言（勾选禁止发帖、回复或私信，填理由和时长，到点自动恢复）/ 解除、举报队列、标签管理（推荐 / 合并 / 删除） |
| 其他 | 输入 @ 自动补全用户名、全站深色模式、手机端布局、草稿自动保存、限流（登录 / 注册 / 发帖 / 搜索 / 上传 / 点赞都有）、统一错误提示、404 页面 |

## 快速开始

```bash
cd 方块盒子论坛
node server/index.js
```

打开 <http://127.0.0.1:3210> 就能看到论坛。

- **第一个注册的账号会自动成为管理员**，直接点右上角「注册」。
- 想直接用命令行建号 / 重置密码：`npm run admin` 或 `node scripts/set-admin.js 账号 密码`。
- 想先看有内容的样子：`npm run seed -- --demo`（演示账号密码都是 `demo1234`，管理员 `admin` / `admin123`）。

改端口等配置：把 `.env.example` 复制成 `.env` 按需修改，不建也能跑。

## 目录结构

```
方块盒子论坛/
├── server/
│   ├── index.js          # HTTP 服务入口：路由分发、静态托管、错误处理
│   ├── config.js         # 读取 .env 与默认配置
│   ├── db.js             # SQLite 连接、事务、分页、计数刷新
│   ├── schema.sql        # 建表语句 + 默认板块
│   ├── lib/
│   │   ├── http.js       # JSON 响应、Cookie、静态文件、跨站检查
│   │   ├── auth.js       # 密码哈希、会话、权限判断
│   │   ├── queries.js    # 主题 / 楼层 / 楼中楼 / 点赞 / 收藏 / 标签的公共查询
│   │   ├── serialize.js  # 数据库行 → 接口 JSON
│   │   ├── notify.js     # 回复通知、@ 提及解析
│   │   ├── images.js     # 图片校验、压缩、缩略图、sharp 可选集成
│   │   ├── png.js        # 纯 JS 的 PNG 解码 / 缩放 / 编码
│   │   ├── rate-limit.js # 进程内限流
│   │   └── validate.js   # 入参校验
│   └── routes/
│       ├── auth.js           # 注册、登录、个人资料、改密码、头像
│       ├── boards-threads.js # 板块、主题、楼层、楼中楼、点赞、收藏、标签
│       ├── community.js      # 站内图床、举报、通知、审核队列
│       ├── users.js          # 用户主页、@ 补全用的用户搜索
│       ├── search.js         # 搜索（标题 / 正文 / 标签）
│       └── admin.js          # 后台数据与用户管理
├── web/                  # 前端页面（服务端直接托管）
│   ├── index.html        # 首页：公告区、板块卡片、最新讨论
│   ├── board.html        # 板块主题列表
│   ├── thread.html       # 主题详情 + 回复
│   ├── new.html          # 发帖
│   ├── login.html        # 登录 / 注册
│   ├── user.html         # 用户主页（自己可编辑资料）
│   ├── notifications.html# 站内通知（同主题折叠）
│   ├── gallery.html      # 我的相册（上传记录、复制 Markdown、删除）
│   ├── search.html       # 搜索结果
│   ├── admin.html        # 管理后台（含审核队列）
│   ├── 404.html
│   └── assets/           # forum.css、core.js（公共库）、page-*.js（各页面逻辑）
├── scripts/
│   ├── seed.js           # 造测试数据
│   ├── set-admin.js      # 建 / 提升管理员
│   ├── backup.js         # 备份数据库与上传文件
│   └── smoke.js          # 端到端冒烟测试（npm run smoke，39 项）
├── deploy/               # 部署物料：systemd、Caddy、Nginx 配置
├── Dockerfile            # 生产镜像（Node 22 alpine）
├── docker-compose.yml
├── docs/
│   ├── API.md            # 接口文档（给启动器 / 第三方接入用）
│   └── 部署.md            # 上线步骤、HTTPS、备份恢复、常见问题
├── data/                 # 运行时生成：数据库与上传的图片（已在 .gitignore）
└── .env.example
```

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。放服务器上对外服务改成 `0.0.0.0`（或用 Nginx 反代保持 `127.0.0.1`） |
| `PORT` | `3210` | 端口 |
| `SITE_NAME` / `SITE_DESC` | 方块盒子论坛 | 站点名与简介，显示在 `/api/me` 与页面标题 |
| `DB_PATH` | `data/forum.db` | 数据库文件路径 |
| `UPLOAD_DIR` | `data/uploads` | 头像存放目录 |
| `PUBLIC_ORIGIN` | 空 | 对外访问地址，例如 `https://forum.blockbox.cc.cd`，用于生成分享链接和跨站校验 |
| `ALLOWED_ORIGINS` | 空 | 允许跨域调接口的前端地址，逗号分隔（官网页面想直接调论坛接口时用） |
| `SESSION_DAYS` | `30` | 登录保持天数 |
| `REGISTER_OPEN` | `1` | `0` 表示关闭注册，只能管理员开号 |
| `TRUST_PROXY` | `0` | 在 Nginx / Caddy 后面时设为 `1`，按 `X-Forwarded-For` 取真实 IP |
| `SECURE_COOKIE` | `0` | 全站 HTTPS 后设为 `1` |
| `LOG_REQUESTS` | `1` | 是否打印访问日志 |
| `MAX_AVATAR_BYTES` | `524288` | 头像大小上限（512 KB） |
| `MAX_COVER_BYTES` | `3145728` | 个人主页封面大小上限（3 MB） |
| `MAX_IMAGE_BYTES` | `4194304` | 帖子内图片大小上限（4 MB），要和反代的 `client_max_body_size` 对齐 |
| `MAX_IMAGE_DIMENSION` | `2560` | 原图长边上限，超过会被等比压缩 |
| `MAX_COVER_DIMENSION` | `1920` | 封面长边上限，超过会被等比压缩 |
| `THUMB_SIZE` | `520` | 缩略图长边，正文里优先加载缩略图 |
| `AVATAR_SIZE` | `256` | 头像最大边长 |
| `ADMIN_BOOTSTRAP_USER` / `ADMIN_BOOTSTRAP_PASS` | 空 | 首次启动时自动建的管理员账号，之后不再生效 |

## 常用命令

```bash
node server/index.js              # 启动（生产）
npm run dev                       # 改代码自动重启（--watch）
npm run smoke                     # 端到端测试：注册→发帖→回复→通知→图床→举报→权限，39 项
npm run backup                    # 备份数据库 + 上传文件到 data/backups
npm run seed -- --demo            # 造演示数据
node scripts/set-admin.js 张三 密码   # 建管理员 / 重置管理员密码
```

## 部署

完整步骤见 [docs/部署.md](docs/部署.md)：systemd 直跑、Docker、Caddy/Nginx 反代、HTTPS、
上线检查清单、备份与恢复、升级迁移、常见问题。最短路径：

```bash
# 服务器上
cd /opt/blockbox-forum && cp .env.example .env    # 改 PUBLIC_ORIGIN / TRUST_PROXY / SECURE_COOKIE
sudo cp deploy/blockbox-forum.service /etc/systemd/system/ && sudo systemctl enable --now blockbox-forum
sudo cp deploy/nginx-forum.conf /etc/nginx/conf.d/forum.conf && sudo certbot --nginx -d forum.blockbox.cc.cd
```

或者用 Docker：`docker compose up -d --build`。

## 和官网、启动器的对接

- 论坛是独立服务，官网仍然是静态站。要加「论坛」入口，在 `方块盒子官网` 的导航里直接指向
  `https://forum.blockbox.cc.cd` 即可，不需要改论坛代码。
- 想从官网页面（或以后的启动器内嵌页面）跨域调论坛接口：在 `.env` 里把官网域名写进
  `ALLOWED_ORIGINS`（例如 `ALLOWED_ORIGINS=https://blockbox.cc.cd`），接口就会返回带 credentials 的 CORS 头。
- 接口清单、参数和示例见 [docs/API.md](docs/API.md)。

## 安全设计

- 密码用 `crypto.scrypt`（N=16384）加盐哈希，数据库里没有明文密码。
- 会话是 32 字节随机 token，存库并可过期；Cookie 为 `HttpOnly` + `SameSite=Lax`，HTTPS 下开 `Secure`。
- 修改类请求校验 `Origin`，跨站提交被拒；所有 SQL 都用参数绑定。
- 前端渲染用户内容时先转义再做 Markdown 处理，链接与图片只允许 `http(s)`，避免 XSS。
- 上传的图片**按文件头判断真实类型**而不是看客户端给的 `content-type`，只放行 PNG / JPG / WebP / GIF（SVG 不在白名单，避免脚本注入）。
- 登录、注册、发帖、回复、搜索、改密码、换头像、传图、举报都有按 IP / 账号的限流。
- 举报记录里保留举报人，只有管理员能看；处理动作会写进举报记录（谁处理的、什么时候）。
- 上传文件只存到 `data/uploads`，文件名由服务端生成；删除时只允许删这个目录。

## 已知限制 / 下一步可以做

- 楼中楼固定两层：回复楼中楼里的回复，会挂到同一个父楼层下，没有无限嵌套（这样楼层和分页不会乱）。
- 点赞只到楼层级；主题没有单独的「赞」；没有 RSS 和按标签订阅。
- 图片压缩和缩略图：内置实现只处理 PNG（截图、导出图够用）；JPEG / WebP / GIF 想压缩和出缩略图要装**可选依赖** sharp（见下）。
- 没有邮件服务：暂不支持邮箱验证、找回密码（可以用 `node scripts/set-admin.js 账号 新密码` 手工重置）。
- 全文搜索是 `LIKE` 匹配（中文两字可用、量级到几万帖都够快）；更大规模可以换成 SQLite FTS5。
- 没有第三方登录（微软正版账号 / QQ / GitHub）——等论坛跑起来再和启动器账号打通。
- 前端是原生 JS，没做表单实时校验。

## 可选：装 sharp 支持全格式压缩

内置的 PNG 处理不依赖任何第三方库，装好就能用；但 JPEG / WebP / GIF 的压缩、缩略图、EXIF 方向矫正
需要 [sharp](https://sharp.pixelplumbing.com/)：

```bash
npm install sharp        # 只影响图片处理，不影响其他功能
```

装好后启动日志里的处理引擎会变成 `sharp`，上传接口返回的 `engine` 字段也会是 `sharp`；
不装时 `engine` 是 `builtin-png`，其他功能完全不受影响。`npm run smoke` 两种情况下都能跑通。

## 许可

与官网保持一致，按 GPL-3.0 发布，© Juanyun0601。
