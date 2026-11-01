# 方块盒子论坛 · 接口文档

- 基础地址：本站根路径（例如 `http://127.0.0.1:3210`）
- 除 `/api/health`、`/api/me`、`/api/boards`、`/api/threads*`（GET）、`/api/search` 外，其余接口都需要登录
- 登录态用 Cookie（`bbf_sid`，HttpOnly）。用脚本调用时把 `set-cookie` 里的值带到后续请求的 `Cookie` 头即可
- 请求体统一 `application/json; charset=utf-8`（上传头像除外，见下）
- 时间字段都是 **Unix 秒**
- 出错时 HTTP 状态码非 2xx，响应体：

```json
{ "error": "用户名或密码不正确", "code": "bad_credentials" }
```

常见状态码：`400` 参数不对 / 业务拒绝，`401` 未登录，`403` 没权限或被禁言，`404` 不存在，
`413` 内容太大，`415` 请求体类型不对，`429` 太频繁。

---

## 认证

### POST /api/auth/register · 注册

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `username` | 是 | 2–20 位，中文 / 字母 / 数字 / 下划线 / 短横线，不能纯数字 |
| `password` | 是 | 6–72 位 |
| `email` | 否 | 只做记录，不发验证邮件 |

成功返回 `{ "user": {...}, "first_user": true }` 并写入登录 Cookie。
**站点第一个注册的账号自动是管理员。** 限流：同一 IP 每小时 6 次。

### POST /api/auth/login · 登录

```json
{ "username": "admin", "password": "admin123" }
```

返回 `{ "user": {...} }` 并写入 Cookie。同一 IP 15 分钟内 30 次、同一账号 10 次。

### POST /api/auth/logout · 退出

清掉会话与 Cookie，返回 `{ "ok": true }`。

### GET /api/me · 当前登录用户

```json
{
  "user": { "id": 1, "username": "admin", "display_name": "admin", "role": "admin", "avatar": "", "cover": "" },
  "unread": 3,
  "friend_unread": 2,
  "site": { "name": "方块盒子论坛", "desc": "…", "register_open": true }
}
```

未登录时 `user` 为 `null`（注意不是 401，方便前端判断），`unread` 为 0。`friend_unread` 是
「未读私信 + 待处理好友申请」合计，给顶栏好友角标用。

---

## 个人资料

### PATCH /api/me

`display_name`（≤24 字）、`bio`（≤300 字）、`email`，都可选，传什么改什么。
把 `email` 改成别的地址后，原邮箱的验证状态会被清掉，需要重新走验证码验证。

### POST /api/me/email/code · 发送邮箱验证码（需登录）

向填写的邮箱发送 6 位数字验证码，10 分钟内有效。需要先在 `.env` 配置好
`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM`，否则返回
`503 {"error": "邮件服务尚未配置，请联系管理员", "code": "mail_disabled"}`。

```json
{ "email": "user@example.com" }
```

成功返回 `{ "ok": true, "expires_in": 600 }`。限流：同一账号 60 秒内只能发一次、
每小时最多 5 封，同一 IP 每小时最多 10 封。邮箱已经验证过再发同一地址会返回
`email_already_verified`。

### POST /api/me/email/verify · 校验邮箱验证码（需登录）

```json
{ "email": "user@example.com", "code": "123456" }
```

校验通过后**绑定该邮箱并标记已验证**，返回 `{ "user": { …, "email_verified": true } }`。
每个验证码最多输错 5 次，超限或过期后需要重新发送。`/api/me` 与本接口返回的
`user` 里，`email_verified` 表示邮箱是否已通过验证。

### POST /api/me/password

```json
{ "current_password": "旧密码", "new_password": "新密码" }
```

改完后除当前设备外的会话全部失效。

### POST /api/me/avatar · 上传头像

请求体是**图片原始字节**，`Content-Type` 为 `image/png` / `image/jpeg` / `image/webp` / `image/gif`，
最大 512 KB。返回 `{ "avatar": "/uploads/u1-1793426400000.png" }`。

```bash
curl -b cookie.txt -X POST http://127.0.0.1:3210/api/me/avatar \
  -H "Content-Type: image/png" --data-binary @avatar.png
```

### DELETE /api/me/avatar · 删除头像

### POST /api/me/cover · 上传个人主页封面

请求体同样是一张图片的原始字节，格式限 PNG / JPG / WebP / GIF，默认最大 3 MB
（`.env` 里的 `MAX_COVER_BYTES`）。服务端会把长边压到 `MAX_COVER_DIMENSION`（默认 1920）以内，
不生成缩略图。返回 `{ "cover": "/uploads/cover-1-1793426400000.png" }`。

建议上传 3:1 的横图（例如 1440×480），显示时会按比例居中裁切。

```bash
curl -b cookie.txt -X POST http://127.0.0.1:3210/api/me/cover \
  -H "Content-Type: image/png" --data-binary @cover.png
```

### DELETE /api/me/cover · 删除个人主页封面

封面地址随用户资料一起返回（`user.cover`），个人主页接口 `/api/users/:id` 同样带这个字段。

---

## 入站答题

发主题和回复都要求账号先通过入站答题（`assertCanPost` 统一拦截），未通过时返回
`403 {"error": "发帖或回复前，需要先通过入站答题", "code": "quiz_required"}`。
答题结果绑定账号（`users.quiz_passed_at / quiz_best_score`），`/api/me` 的 `user` 里带
`quiz_passed / quiz_passed_at / quiz_best_score`。

### GET /api/quiz/bank · 题库（需登录）

返回 `rules`（`question_count: 50` / `points_per_question: 2` / `pass_score: 80`）、题目总数
`count`，以及全部题目 `questions`：每题含 `id / text / options[4] / answer_index / explanation`。
判分在客户端完成，答案随题库下发。

### POST /api/quiz/complete · 记录答题结果（需登录）

请求体 `{"score": 96}`（0–100 整数，限每小时 12 次）。达到及格线才把账号标记为已通过，
`quiz_best_score` 保留历史最高分：

```json
{ "ok": true, "quiz_passed": true, "quiz_best_score": 96, "first_time": true }
```

---

## 站内图床

### POST /api/upload · 上传帖子图片

请求体和头像一样是**图片原始字节**，`Content-Type` 给 `image/png` 等即可（服务端按文件头校验，
只认 PNG / JPG / WebP / GIF）。默认上限 4 MB（`.env` 里的 `MAX_IMAGE_BYTES`）。

```json
{
  "url": "/uploads/img-1-1793426400000-a1b2c3.png",
  "thumb": "/uploads/thumbs/img-1-1793426400000-a1b2c3.png",
  "width": 1600, "height": 1000,
  "size": 183975, "original_size": 183975,
  "optimized": false, "engine": "builtin-png", "mime": "image/png"
}
```

- **压缩**：长边超过 `MAX_IMAGE_DIMENSION`（默认 2560）会被等比缩到上限内；
  装了 `sharp` 时还会按格式重压（JPEG 82%、PNG 调色板、WebP 82%）
- **缩略图**：长边超过 `THUMB_SIZE`（默认 520）时生成到 `/uploads/thumbs/`，
  前端渲染正文时把 `![](原图)` 自动换成缩略图，点开才是原图（缩略图缺失时服务端自动回退原图，不会 404）
- `engine`：`builtin-png`（内置 PNG 处理）或 `sharp`（装了 sharp 的全格式处理）

返回的 `url` 直接放进正文的 Markdown 里：`![](/uploads/img-1-....png)`。
限流：每账号每小时 40 张。

```bash
curl -b cookie.txt -X POST http://127.0.0.1:3210/api/upload \
  -H "Content-Type: image/png" --data-binary @shot.png
```

---

## 通知

### GET /api/notifications?page=1&per_page=20

**按「同一主题 + 同一类型」折叠**：一个人连回三句只占一行，`count` 是条数、`actors` 是去重后的人。

```json
{
  "items": [
    {
      "id": 12, "type": "reply", "target_kind": "thread",
      "thread_id": 4, "post_id": 9,
      "thread_title": "分享一个 1.20.4 的整合包配置",
      "excerpt": "Sodium 那几项在 1.20.4 上确实稳…",
      "count": 3, "actor_count": 2,
      "actors": [ { "id": 2, "username": "红石工程师", "display_name": "红石工程师", "avatar": "" } ],
      "ids": [12, 11, 10],
      "unread": true, "unread_count": 3,
      "created_at": 1793428700
    }
  ],
  "unread": 3,
  "pagination": { "page": 1, "per_page": 20, "total": 1, "pages": 1 }
}
```

- `type`：`reply` / `mention` / `system`
- `target_kind`：`thread`（回复我的主题）或 `post`（回复我的楼层 / 楼中楼），前端据此显示不同文案
- `ids`：这一组里所有通知的 id，点开时一次性标记已读
- `pagination.total` 是**分组后**的条数

### POST /api/notifications/read · 标记已读

```json
{ "ids": [12, 13] }     // 只标记指定几条（通知组传整组 ids）
{}                      // 不传 ids 表示全部标为已读
```

返回 `{ "ok": true, "changed": 2, "unread": 0 }`。

### DELETE /api/notifications/:id · 删除一条通知

返回 `{ "ok": true, "unread": 0 }`。

---

## 我的相册

### GET /api/me/uploads?page=1&per_page=24

```json
{
  "uploads": [
    { "id": 7, "url": "/uploads/img-1-....png", "thumb": "/uploads/thumbs/img-1-....png",
      "mime": "image/png", "width": 900, "height": 600, "size": 48123, "kind": "img",
      "created_at": 1793428700 }
  ],
  "pagination": { "page": 1, "per_page": 24, "total": 1, "pages": 1 }
}
```

### DELETE /api/me/uploads/:id · 删除相册图片

同时删除原图与缩略图文件（帖子里的引用会变成裂图，前端会二次确认）。

---

## 举报

### POST /api/reports · 举报楼层

```json
{ "post_id": 9, "reason": "广告 / 人身攻击 / 刷屏…" }
```

- 不能举报自己，同一人对同一楼层重复举报只更新理由，不会重复入队
- `reason` 最多 200 字
- 限流：每账号每小时 10 次

返回 `{ "ok": true }`，重复提交时带 `"duplicated": true`。

---

## 用户反馈

官网/论坛页脚与启动器「设置 > 关于」提交的软件问题反馈，登录后可提交，管理员在后台处理。

### POST /api/feedback · 提交反馈（需登录）

问题反馈（`type = bug`）字段与 GitHub Issue 模板（`.github/ISSUE_TEMPLATE/bug_report.yml`）一致，由服务端校验并组装成 `### 标题` 格式的正文：

```json
{
  "type": "bug",
  "app_version": "beta6",
  "platform": "Windows（x64）",
  "os_version": "Windows 11 23H2",
  "description": "启动 1.20.1 实例时闪退",
  "steps": "1. 选择实例\n2. 点启动",
  "expected": "正常进入游戏",
  "actual": "闪退回到主页",
  "logs": "（可选）导出日志的关键行",
  "screenshots": "（可选）截图链接或说明",
  "source": "web"
}
```

- 必填：`app_version`（启动器版本，1–40 字）、`platform`（运行平台，五选一：Windows（x64）/ Windows（ARM64）/ Android / 鸿蒙 HarmonyOS / 其他）、`description`（问题描述，5–800 字）、`steps`（复现步骤，2–800 字）
- 选填：`os_version`（系统版本 ≤100）、`expected` / `actual`（期望 / 实际结果 ≤400）、`logs`（日志 ≤2000）、`screenshots`（截图 / 录屏 ≤500）

功能建议（`type = feature`）只需 `description`（建议内容，5–800 字），可选 `scene`（使用场景 ≤800 字）：

```json
{ "type": "feature", "description": "希望能批量导出截图", "scene": "做整合包宣传时" }
```

- 兼容旧写法：只传 `content`（5–1000 字）也可以
- `source` 为 `web`（网页）或 `launcher`（启动器）
- 限流：每账号每小时 5 条

返回 `{ "ok": true, "id": 12 }`。

### GET /api/feedbacks?status=all&page=1 · 公开反馈列表（无需登录）

仿 GitHub Issues 列表页：所有人可见，带状态筛选与计数。`title` 为从正文提取的第一行问题描述 / 建议内容。

```json
{
  "status": "all",
  "feedbacks": [ { "id": 12, "type": "bug", "status": "open", "title": "启动 1.20.1 实例时闪退",
                   "content": "### 启动器版本\n…", "reply": "", "handled_at": 0,
                   "created_at": 1793600000, "user": { "id": 2, "username": "…", "display_name": "…" } } ],
  "counts": { "open": 3, "resolved": 1, "ignored": 0 },
  "pagination": { "page": 1, "per_page": 20, "total": 4, "pages": 1 }
}
```

`status` 支持 `all`（默认）/ `open` / `resolved` / `ignored`；`reply` 为管理员的公开回复。

### GET /api/me/feedbacks?page=1&per_page=20 · 我的反馈（需登录）

```json
{
  "feedbacks": [ { "id": 12, "type": "bug", "source": "launcher", "content": "【问题】…\n\n【复现步骤】…",
                   "app_version": "beta7",
                   "status": "open", "reply": "", "handled_at": 0, "created_at": 1793600000 } ],
  "pagination": { "page": 1, "per_page": 20, "total": 1, "pages": 1 }
}
```

`type`：`bug`（问题反馈）/ `feature`（功能建议）；`status`：`open`（待处理）/ `resolved`（已处理）/ `ignored`（已忽略）；管理员回复在 `reply`。

### GET /api/admin/feedbacks?status=open&page=1 · 反馈列表（管理员）

`status` 支持 `open` / `resolved` / `ignored` / `all`。每条带提交人 `user`（未登录提交为 null）、处理人 `handled_by` 与三种状态的 `counts`，带 `pagination`。

### PATCH /api/admin/feedbacks/:id · 处理反馈（管理员）

```json
{ "status": "resolved", "reply": "下个版本修复，感谢反馈！" }
```

`status` 为 `resolved` / `ignored` / `open`（重开），`reply` 最多 500 字、可选；处理人与处理时间自动记录。返回 `{ "ok": true, "status": "resolved" }`。

---

## 联机大厅

启动器在「实例助手 → 联机」里把本机开好的房间发布到大厅。房间靠心跳续命：客户端每 40 秒调一次心跳，
超过 **2 分钟**没有心跳的房间会被自动清掉（离开房间时客户端也会主动删除）。网页端只展示邀请码 / 连接地址。

### GET /api/lobby/rooms · 房间列表（公开）

查询参数：`q`（房间名 / 简介 / 房主，最多 40 字）、`core`（`terracotta` / `hongshi` / `frp` / `custom`）、
`version`（游戏版本前缀）、`page`、`per_page`（默认 30，最多 60）。

```json
{
  "rooms": [
    {
      "id": 4,
      "title": "1.20.1 原版生存",
      "description": "长期开，欢迎萌新",
      "core": "terracotta",
      "core_label": "陶瓦联机",
      "invite_code": "U/ABCD-EFGH-IJKL-MNOP",
      "address": "",
      "game_version": "1.20.1",
      "loader": "Forge",
      "mods": ["jei.jar", "sodium.jar"],
      "max_players": 8,
      "status": "waiting",
      "join_count": 12,
      "host": { "id": 2, "username": "红石工程师", "display_name": "红石工程师", "avatar": "" },
      "created_at": 1793600000,
      "updated_at": 1793600120,
      "expires_in": 90,
      "mine": false
    }
  ],
  "total": 1,
  "pagination": { "page": 1, "per_page": 30, "total": 1, "pages": 1 },
  "server_time": 1793600130
}
```

- `core`：`terracotta`（陶瓦联机，用 `invite_code`）/ `hongshi`（红石联机，用 `address`）/
  `frp`（樱花或 OpenFrp 内网穿透，用 `address`）/ `custom`（直连地址）。
- `status`：`waiting`（等待中）/ `playing`（游戏中）/ `full`（人数已满）。
- `expires_in`：距离过期还有多少秒，`0` 表示已经过期（列表里不会出现）。
- 登录后请求时 `mine` 表示这条房间是不是自己的；未登录一律 `false`。

### POST /api/lobby/rooms · 发布 / 更新自己的房间（需登录）

同一个账号只会保留一个房间，重复发布会覆盖上一条，并刷新心跳。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 是 | 房间名，2–40 字 |
| `description` | 否 | 简介，最多 200 字 |
| `core` | 否 | `terracotta` / `hongshi` / `frp` / `custom`，默认 `custom` |
| `invite_code` | 二选一 | 陶瓦邀请码，最多 120 字符 |
| `address` | 二选一 | 红石 / frp 的连接地址（`主机:端口`），最多 120 字符 |
| `game_version` | 否 | 游戏版本，最多 32 字符 |
| `loader` | 否 | 加载器（`Vanilla` / `Forge` / `Fabric` / `NeoForge` / `Quilt`） |
| `mods` | 否 | 模组文件名数组，最多 80 个、单个最多 120 字符 |
| `max_players` | 否 | 1–64，默认 8 |
| `status` | 否 | `waiting` / `playing` / `full`，默认 `waiting` |

`invite_code` 与 `address` 至少要有一个，否则返回
`400 {"error": "请提供邀请码或连接地址", "code": "lobby_join_info_required"}`。
限流：同一账号每分钟 20 次。成功返回 `{ "room": { … } }`（结构同列表里的单条）。

### POST /api/lobby/rooms/:id/heartbeat · 心跳续期（需登录，仅房主）

```json
{ "status": "playing" }
```

`status` 可选，用来同步「等待中 / 游戏中 / 已满」。房间已过期或不是自己的会返回
`404 {"error": "房间已过期，请重新发布", "code": "lobby_room_gone"}`，客户端应重新发布。
成功返回 `{ "ok": true, "room": { … } }`。

### DELETE /api/lobby/rooms/:id · 关闭房间（需登录，房主或管理员）

删除后大厅里立刻看不到。房间已经过期时返回 `{ "ok": true, "removed": false }`，不报错。

### POST /api/lobby/rooms/:id/join · 记录一次加入（公开）

客户端点「一键加入」时调用，给房间的 `join_count` 加一，并返回最新房间信息
（`{ "room": { … } }`）。房间不存在或已过期返回 `404 lobby_room_gone`。
限流：同一 IP 每分钟 60 次。

---

## 用户

### GET /api/users/search?q=关键词

给「@ 自动补全」用的轻量搜索，按用户名 / 昵称匹配，最多 8 个，已封禁用户不返回。

```json
{ "users": [ { "id": 2, "username": "红石工程师", "display_name": "红石工程师", "avatar": "", "role": "user" } ] }
```

### GET /api/users/:id

```json
{
  "user": { "id": 2, "username": "小白玩家", "display_name": "小白玩家", "bio": "", "avatar": "",
            "cover": "/uploads/cover-2-1793426400000.png", "role": "user",
            "status": "active", "thread_count": 1, "post_count": 1, "created_at": 1793426400 },
  "friendship": "none",
  "threads": [ /* 最近 8 个主题 */ ],
  "replies": [ { "thread_id": 3, "thread_title": "…", "snippet": "…" } ],
  "thread_total": 1
}
```

`friendship` 只有登录时才有意义：`self`（自己）/ `none` / `outgoing`（我申请了对方）/ `incoming`（对方申请了我）/ `friends`。

### GET /api/users/:id/threads?page=1&per_page=20

用户发过的主题，带 `threads` 与 `pagination`。

### GET /api/users/:id/posts?page=1&per_page=20

用户发过的回复（不含 1 楼），带所属主题标题、`total` 与分页信息。

---

## 好友与私信

好友关系是双向的：A 申请 → B 通过后才能互发私信。申请发给别人时如果对方恰好也申请过我，会直接成为好友。

### GET /api/friends · 好友页数据（一次拉全）

```json
{
  "friends": [
    { "id": 2, "username": "红石工程师", "display_name": "红石工程师", "avatar": "",
      "last_seen_at": 1793426400, "online": true, "unread": 1,
      "last_message": { "body": "晚上一起开黑？", "created_at": 1793426400, "mine": false } }
  ],
  "incoming": [ { "id": 7, "created_at": 1793426400, "user": { "id": 3, "username": "小白玩家", "…": "…" } } ],
  "outgoing": [ { "id": 8, "created_at": 1793426400, "user": { "id": 4, "username": "老玩家", "…": "…" } } ],
  "total_unread": 1
}
```

`online` 为最近 10 分钟内活跃。`last_message` 为空表示还没聊过。最多返回 200 个好友，按最近联系排序。

### POST /api/friends/requests · 发好友申请

`user_id` 或 `username` 二选一。返回 `{ "ok": true, "status": "pending" | "friends" }`，
`friends` 表示对方之前也申请过我、已直接通过。限流：每小时 20 次。

### POST /api/friends/requests/:id/accept · 通过申请

只能处理发给自己的申请，返回 `{ "ok": true, "status": "friends", "user_id": 对方id }`。

### POST /api/friends/requests/:id/decline · 拒绝申请

### DELETE /api/friends/requests/:id · 撤回我发出的申请

### DELETE /api/friends/:userId · 删除好友

### GET /api/messages/:userId · 与某好友的私信历史

可选 `before_id`（取更早的一页）与 `limit`（默认 40，最大 100）。**调用即把对方发来的未读消息标记已读。**

```json
{
  "user": { "id": 2, "username": "红石工程师", "…": "…" },
  "messages": [ { "id": 12, "body": "好啊几点", "mine": true, "created_at": 1793426400, "read_at": 1793426410 } ],
  "has_more": false
}
```

`messages` 按时间升序。不是好友时返回 403。

### POST /api/messages/:userId · 发私信

```json
{ "body": "晚上 8 点？" }
```

内容 1–1000 字，限流：每分钟 30 条。返回 `{ "message": { "id": 13, "body": "…", "mine": true, "created_at": … } }`。

### GET /api/messages/poll · 轮询（角标 / 会话列表 / 新消息）

可选 `peer_id`（当前打开的会话）与 `after_id`（已拿到的最大消息 id）。不标记已读。

```json
{
  "total_unread": 2,
  "incoming_requests": 1,
  "friends": [ { "id": 2, "unread": 2, "online": true, "last_message": { "…": "…" } } ],
  "messages": [ { "id": 14, "body": "就现在？", "mine": false, "created_at": 1793426500, "read_at": 0 } ]
}
```

`friends` 字段与 GET /api/friends 相同（含头像昵称，新好友出现时可以直接补进列表）。限流：每分钟 240 次。

---

## 板块

### GET /api/boards

```json
{
  "boards": [
    { "id": 1, "slug": "general", "name": "综合讨论", "description": "…", "icon": "💬",
      "thread_count": 12, "post_count": 34, "last_thread": { "id": 7, "title": "…" } }
  ],
  "stats": { "users": 4, "threads": 3, "posts": 3, "online": 4, "new_users": 4, "newest_user": {…} }
}
```

`online` 指 15 分钟内活跃过的用户数。

### GET /api/boards/:slug?sort=latest|new|hot&tag=优化&page=1&per_page=25

返回 `{ "board": {...}, "threads": [...], "pagination": {...} }`。默认板块 slug：
`general` `help` `guide` `plugin` `feedback` `chat`。

---

## 主题

### GET /api/threads?sort=latest|new|hot&tag=优化&page=1&per_page=20

全站主题列表（首页用）。`tag` 可选，按标签筛选。

### GET /api/tags

标签云：管理员设为「推荐」的标签排在前面（`featured: true`），其余按使用次数排序，最多 20 个。

```json
{ "tags": [ { "tag": "优化", "n": 3, "featured": true } ] }
```

### GET /api/threads/:id?page=1&per_page=20

```json
{
  "thread": {
    "id": 1, "title": "…", "pinned": false, "locked": false, "views": 3, "reply_count": 4,
    "board": {…}, "author": {…}, "created_at": 1793426400,
    "tags": ["优化", "1.20.4"], "bookmarked": true
  },
  "posts": [
    {
      "id": 1, "floor": 1, "parent_post_id": null, "content": "原文（Markdown）",
      "likes": 3, "liked": true, "children_count": 2,
      "children": [
        { "id": 8, "floor": 2, "parent_post_id": 1, "content": "楼中楼内容", "likes": 1, "liked": false }
      ],
      "author": {…}, "deleted": false
    }
  ],
  "pagination": { "page": 1, "per_page": 20, "total": 2, "pages": 1 }
}
```

- `posts` 只含**顶层楼层**（`parent_post_id: null`），分页按顶层楼层算
- 楼中楼放在父楼层的 `children` 里；`children_count` 是不含已删除楼层的数量
- `liked` / `bookmarked` 需要带登录 Cookie，未登录时是 `false`
- 同一 IP 对同一主题 10 分钟内只计一次浏览量

### POST /api/threads · 发主题

```json
{ "board": "help", "title": "启动报 Java 找不到", "content": "正文，支持 Markdown", "tags": ["优化", "1.20.4"] }
```

`board` 可以写 slug 或板块 id，不写默认 `general`；标题 2–80 字，正文 2–20000 字；
`tags` 最多 4 个、每个最多 12 字。返回 `{ "id": 12, "thread": {...} }`。限流：每账号每小时 6 帖。

### PATCH /api/threads/:id · 改标题 / 改标签

```json
{ "title": "新标题", "tags": "优化,低配" }
```

传 `tags`（数组或逗号分隔字符串）会整体替换标签。作者本人或管理员可用。

### DELETE /api/threads/:id · 删主题（软删除）

作者本人或管理员可用，同时清掉搜索索引、通知和待处理举报，并重算板块计数。

### POST /api/threads/:id/bookmark · 收藏 / 取消收藏

不传 body 就是切换，返回 `{ "bookmarked": true }`。

### GET /api/me/bookmarks?page=1&per_page=20

我收藏的主题，返回 `{ "threads": [...], "pagination": {...} }`。

### POST /api/me/content-favorites · 收藏启动器在线资源

启动器「资源」页的收藏（模组 / 整合包等，CurseForge / Modrinth），跟论坛帖子收藏相互独立。

```json
{ "source": "curseforge", "remote_id": "12345", "content_type": "Mod",
  "meta": { "name": "JEI", "chineseName": "...", "iconUrl": "...", "author": "..." } }
```

- `source` 仅支持 `curseforge` / `modrinth`；`meta` 是客户端资源快照，最大 8KB
- 同一资源重复收藏会刷新 `content_type` / `meta`，返回 `{ "ok": true }`

### GET /api/me/content-favorites?page=1&per_page=20

我收藏的在线资源，返回 `{ "items": [{ "source", "remote_id", "content_type", "meta", "created_at" }], "pagination": {...} }`，按收藏时间倒序。

### DELETE /api/me/content-favorites/:source/:remote_id

取消收藏一个在线资源，返回 `{ "ok": true }`；不存在返回 404。

### POST /api/me/content-favorites/bulk · 批量补传

登录后对账用：body 为 `{ "items": [上面的单条格式] }`（单次最多 200 条），只插入云端缺失的，返回 `{ "added": N }`。

---

## 回复

### POST /api/threads/:id/posts

```json
{ "content": "回复内容" }
{ "content": "这是楼中楼", "reply_to": 12 }
```

- `reply_to` 传父楼层 id 就是**楼中楼**；如果回复的是别人的楼中楼，会挂到同一个父楼层下（固定两层结构）
- 不传 `reply_to` 是普通楼层，楼层号照常递增
- 返回 `{ "post": { "parent_post_id": 12, ... }, "thread_id": 1 }`
- 帖子锁定后只有管理员能回复。限流：每账号 5 分钟 12 条

### POST /api/posts/:id/like · 点赞 / 取消点赞

不传 body 就是切换，返回 `{ "liked": true, "likes": 3 }`。

### GET /api/me/likes?page=1&per_page=20 · 我赞过的

```json
{
  "likes": [
    { "post_id": 9, "thread_id": 4, "floor": 2,
      "thread_title": "…", "board": { "slug": "guide", "name": "教程与分享" },
      "snippet": "被点赞楼层的摘要", "liked_at": 1793428700, "post_created_at": 1793428600,
      "author": { "id": 2, "username": "红石工程师", "display_name": "红石工程师", "avatar": "" } }
  ],
  "pagination": { "page": 1, "per_page": 20, "total": 1, "pages": 1 }
}
```

### PATCH /api/posts/:id · 改回复

`{ "content": "新内容" }`，作者本人或管理员，会累加 `edit_count`（前端显示“已编辑”）。

### DELETE /api/posts/:id · 删回复（软删除）

楼层保留占位，不会跳号。删顶层楼层时，它下面的楼中楼一起不再展示。

---

## 搜索

### GET /api/search?q=关键词&board=help&page=1&per_page=20

```json
{
  "query": "Java",
  "results": [ { "id": 1, "title": "…", "board": {…}, "snippet": "…命中片段…" } ],
  "pagination": { "page": 1, "per_page": 20, "total": 1, "pages": 1 }
}
```

匹配标题与正文，`q` 最长 60 字符，支持中文两字检索；`board` 可选，用于限定板块。限流：每 IP 每分钟 40 次。

---

## 管理（都需要管理员）

### GET /api/admin/overview

站点统计、全部板块、最近 10 个用户 / 主题 / 回复。

### GET /api/admin/visits?days=30

访问数据：浏览量（PV）、访客数（UV）、日活、月活。

- 只统计真实打开的 HTML 页面，`/api/*` 接口、`/uploads`、`/assets` 静态资源、管理后台和常见爬虫都不计入。
- 访客按「IP + 浏览器标识」的哈希去重，库里不存原始 IP；同一台设备换浏览器算两个人。
- 明细保留 `VISIT_RETENTION_DAYS`（默认 400）天，`days` 最多取 365。

```json
{
  "range_days": 30,
  "retention_days": 400,
  "summary": {
    "today":     { "pv": 128, "uv": 26, "users": 8, "new_visitors": 4 },
    "yesterday": { "pv": 96,  "uv": 21, "users": 7 },
    "week":      { "pv": 720, "uv": 88, "users": 19 },
    "month":     { "pv": 3100, "uv": 210, "users": 43 },
    "total":     { "pv": 9800, "uv": 460, "last_seen_at": 1793451200 },
    "peak":      { "day": "2026-10-20", "pv": 231 },
    "online": 5
  },
  "series": [{ "day": "2026-10-03", "pv": 42, "uv": 11 }],
  "hours": [{ "hour": 0, "pv": 3, "uv": 2 }],
  "pages": [{ "path": "/thread.html", "label": "帖子页", "pv": 1200, "uv": 160 }]
}
```

`summary.today.uv` 即日活（DAU），`summary.month.uv` 是近 30 天去重访客（月活 MAU）。
`series` 一定包含请求范围里的每一天（没有访问的补 0），`hours` 固定 24 条。

### GET /api/admin/users?q=&page=1&per_page=30

用户列表（含邮箱与状态）。

### PATCH /api/admin/users/:id

```json
{ "role": "admin" }                          // 设为管理员（"user" 降回成员）
{ "role": "moderator" }                      // 设为次级管理员（"user" 降回成员）
{ "status": "muted",                          // 禁言：勾选禁止内容 + 理由 + 时长
  "mute_scope": "thread,reply",               // 禁止内容：thread 发帖 / reply 回复 / dm 私信，全选等于 "all"
  "mute_reason": "连续发广告",                 // 理由，最多 100 字，会显示给被禁言的人
  "mute_hours": 24 }                          // 时长：>0 从现在起算小时数，0 表示永久（手动解除）
{ "status": "banned" }                       // 封禁，同时踢下线（后台界面已不提供，接口仍保留）
{ "status": "active" }                       // 恢复正常 / 解除禁言（禁言信息一并清空）
```

不能修改自己的角色，也不能禁言自己。次级管理员可以做这里的所有事，唯独不能改任何人的 `role`（改角色仅限管理员）。

禁言到期后，用户下次被管理后台读到时自动恢复成 `active`；到期前也可以随时用 `status: "active"` 提前解除。

角色取值：`user`（成员）/ `moderator`（次级管理员）/ `admin`（管理员）。

### GET /api/admin/reports?status=open

审核队列。`status` 取 `open`（默认）/ `resolved` / `ignored`。

```json
{
  "status": "open",
  "reports": [
    {
      "id": 3, "post_id": 9, "thread_id": 4, "floor": 2,
      "reason": "广告", "status": "open", "created_at": 1793428700,
      "thread_title": "…", "post_deleted": false, "thread_deleted": false,
      "excerpt": "被举报楼层的正文摘要",
      "author": { "id": 2, "username": "红石工程师" },
      "reporter": { "id": 3, "username": "整合包爱好者" }
    }
  ],
  "counts": { "open": 1, "resolved": 0 }
}
```

### PATCH /api/admin/reports/:id · 处理举报

```json
{ "status": "resolved", "delete_post": true }   // 删掉被举报楼层并标记已处理
{ "status": "ignored" }                          // 只是忽略
{ "status": "open" }                             // 重新打开
```

`delete_post` 会软删除该楼层、减掉主题回复数、重算板块计数，并清掉指向它的通知。

### PATCH /api/admin/threads/:id

```json
{ "pinned": true }        // 置顶 / 取消
{ "locked": true }        // 锁定 / 解锁
{ "board": "chat" }       // 换板块
```

### POST /api/admin/boards · 新增板块

```json
{ "slug": "modpack", "name": "整合包", "description": "整合包相关", "icon": "📦", "sort_order": 70 }
```

`slug` 只能是小写字母 / 数字 / 短横线，2–31 位且唯一。

### PATCH /api/admin/boards/:id

`name`、`description`、`icon`、`sort_order` 任选。

### DELETE /api/admin/boards/:id

板块里还有主题时会被拒绝。

### POST /api/admin/rescan

按实际数据重算板块与用户计数（数据看着不对时用）。

### GET /api/admin/tags · 标签管理列表

```json
{
  "tags": [ { "tag": "优化", "count": 3, "featured": true, "sort_order": 0 } ],
  "featured": ["优化"]
}
```

### POST /api/admin/tags/feature · 推荐 / 取消推荐

```json
{ "tag": "优化", "featured": true, "sort_order": 10 }
```

推荐标签会出现在首页标签云的前面；`sort_order` 小的排前面。

### POST /api/admin/tags/merge · 合并标签

```json
{ "from": ["优化", "优化设置"], "to": "优化" }
```

把 `from` 里的标签全部换成 `to`（帖子不会丢），返回 `{ "ok": true, "into": "优化", "threads": 5 }`。
如果这些标签之前是推荐状态，会一起迁移到新标签上。

### POST /api/admin/tags/delete · 删除标签

```json
{ "tag": "优化" }
```

从所有帖子上移除该标签，并取消推荐，返回 `{ "ok": true, "tag": "优化", "removed": 3 }`。

---

## 健康检查

### GET /api/health

```json
{ "ok": true, "service": "blockbox-forum", "version": "0.1.0", "time": 1793426400 }
```

不需要登录，适合给监控 / 反向代理探活。

---

## 完整调用示例（Node.js 22 自带 fetch）

```js
const base = 'http://127.0.0.1:3210';
let cookie = '';

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res.json();
}

await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
const { id } = await call('POST', '/api/threads', {
  board: 'feedback',
  title: '来自启动器的反馈',
  content: '这里是正文',
});
console.log('新主题 id：', id);
```
