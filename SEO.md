# 搜索引擎优化（SEO）说明

> 目标：让「方块盒子 / BlockBox」相关的品牌词和长尾词在百度、必应、谷歌里能被搜到、排得上去。
> 本文分三部分：**已经做好的**（代码里，随部署生效）、**需要你在后台点一下的**（各家站长平台）、**能继续加分的**（服务器与内容运营）。

站点域名：`https://mcblockbox.top/`（全站 canonical 都指向它，不要再用别的域名做主入口）。

---

## 一、已经做好的（随推送部署生效）

| 项目 | 文件 | 作用 |
| --- | --- | --- |
| 抓取入口 | `robots.txt` | 全站允许抓取，并声明 sitemap 地址 |
| 站点地图 | `sitemap.xml` | 首页 / 下载页 / 开发文档 / 更新日志 / 网站地图五个地址，带 lastmod 与权重 |
| 网站地图页 | `sitemap.html` | 给访客看的「网站地图」页面：全站页面与栏目一页列全，四个页面页脚都能点进来，也帮搜索引擎顺内链 |
| 规范网址 | 四个页面的 `rel="canonical"` | 避免 `?lang=`、www、别的域名造成重复页面分散权重 |
| 标题与描述 | 四个页面的 `<title>` / `description` | 标题里带上「Minecraft（我的世界）启动器」「免费开源」等搜索词；描述写清平台与卖点 |
| 分享卡片 | Open Graph + Twitter Card + `assets/img/og-cover.png` | 在 QQ / 微信 / 微博 / B 站 / Discord 里分享时显示统一封面 |
| 结构化数据 | 四页的 JSON-LD | 首页声明软件（软件名、平台、免费价格、开源许可）与 FAQ，下载 / 文档 / 日志页声明面包屑 |
| 常见问题 | 首页 `#faq` | 7 组高频问答（是否收费、支持系统、要不要正版、能不能从 PCL2/HMCL 迁移…），对应百度「大家还在问」一类的长尾搜索 |
| 首页瘦身 | `assets/img/cube.webp` | 首屏立方体从 139 KB PNG 降到 17 KB WebP（老浏览器自动回退 PNG），首屏更快 |
| 推送密钥 | `<密钥>.txt` + `tools/indexnow.mjs` | IndexNow 密钥文件与推送脚本，见下一节 |
| 多语言 | `assets/i18n/*.js` | 新增的标题、描述与 FAQ 文案已同步 5 种外文，不会出现中英混排 |

自检（改完页面后建议跑一次）：`python _tmp/seo_check.py` 会检查标签闭合、JSON-LD 能否解析、必备 meta 是否齐全、本地资源是否存在。

---

## 二、需要你在后台点一下（一次性，每家约 5 分钟）

代码侧做完只解决「搜索引擎抓得到、看得懂」，**还得主动告诉它们「这个站存在」**。首页 `<head>` 里已经留好验证标签的注释位，拿到验证串后取消注释填进去即可：

```html
<!-- <meta name="baidu-site-verification" content=""> -->
<!-- <meta name="google-site-verification" content=""> -->
<!-- <meta name="msvalidate.01" content=""> -->
```

### 1. 百度搜索资源平台（国内最要紧）

1. 打开 <https://ziyuan.baidu.com>，登录后「用户中心 → 站点管理 → 添加网站」，填 `https://mcblockbox.top`。
2. 验证方式选 **HTML 标签**，把给出的 `<meta name="baidu-site-verification" content="xxxx" />` 填进首页预留位并部署。
3. 验证通过后进「资源提交 → 普通收录」，提交 `https://mcblockbox.top/sitemap.xml`。
4. 顺手开通「API 提交」拿 token（可选，后面可以写进 `tools/` 里做自动推送）。

### 2. 必应网站管理员工具（IndexNow 的主场）

1. 打开 <https://www.bing.com/webmasters>，添加站点 `https://mcblockbox.top`。
2. 验证可用 **导入 Google Search Console**（最快），或填 `msvalidate.01` 标签。
3. 「站点地图」里提交 `sitemap.xml`。

### 3. Google Search Console（海外流量 / 谷歌系）

1. <https://search.google.com/search-console> → 添加「网址前缀」`https://mcblockbox.top/`。
2. 选 HTML 标记验证，填 `google-site-verification`。
3. 提交 `sitemap.xml`；「网址检查」里可以对首页手动请求编入索引一次。

> 谷歌在境内的抓取不稳定，英文 / 西语 / 俄语页面能不能被收录要看运气；但 5 种语言的路由都是同一批 URL，不影响主站。

### 4. 可选：360 站长平台、搜狗站长平台、Yandex Webmaster

面向国内 360 / 搜狗搜索与俄语用户，流程和上面一样（验证 + 提交 sitemap），有时间再做。

---

## 三、IndexNow 推送（每次改完内容跑一次）

必应、Yandex、Seznam、Naver 共用 IndexNow 协议：只要站点根目录放着那枚密钥文件，POST 一次就会通知它们来抓。

```bash
node tools/indexnow.mjs            # 推送 sitemap.xml 里的全部地址
node tools/indexnow.mjs --dry-run  # 只看要推哪些，不发请求
```

- 返回 `200` / `202` 表示已接收，通常几小时到几天内收录。
- 返回 `403`：多半是密钥文件没传上去（文件名和内容都必须等于脚本里的 `INDEXNOW_KEY`）。
- 别几分钟内反复推同一批地址，会被当成滥用。

---

## 四、服务器侧还能加的分（需要 SSH 权限，本次未改）

现在 nginx 已经开了 gzip，但还缺缓存头与 HTTP/2。把下面这段加进 `mcblockbox.top` 的 `server {}` 里（改完 `nginx -t && systemctl reload nginx`）：

```nginx
# 静态资源长缓存（文件名没变就一直用本地缓存），HTML 每次回源
location ~* \.(?:css|js|png|jpe?g|webp|ico|svg|woff2?)$ {
    expires 30d;
    add_header Cache-Control "public, max-age=2592000, immutable";
}
location ~* \.html$ {
    add_header Cache-Control "no-cache";
}

# 开启 HTTP/2（HTTPS server 的 listen 行加 http2）
# listen 443 ssl http2;

# 别让 www 和主域名各算一个站点
server {
    listen 443 ssl;
    server_name www.mcblockbox.top;
    return 301 https://mcblockbox.top$request_uri;
}
```

页面速度会直接影响移动端排名，缓存头是性价比最高的一项。

---

## 五、内容与外部链接（排名真正的长线）

技术项只是「资格线」，排名靠的是**持续的新内容 + 站外有人提到你**。

**站内**

- 每次发版都更新 `changelog.html`（现在由后台发布版本时写入 `latest.json`，天然有新鲜度，搜索引擎喜欢）。
- 一篇内容打一个搜索意图：例如把「3D 皮肤编辑器」「联机开黑」「AI 助手能做什么」单独做成页面 / 文章，比全塞首页更容易吃到长尾词。
- 首页 FAQ 里的问答可以继续加（用户在论坛、客服、抖音评论里问得最多的问题，就是最该写的标题）。

**站外（外链 = 权重）**

- B 站视频简介、抖音主页、爱发电主页都放官网链接（已有部分，检查一遍是否带 `https://mcblockbox.top/`）。
- GitHub 仓库（`Juanyun0601/BlockBox`）的 About 里填官网地址，README 顶部放一行「官网：https://mcblockbox.top」。
- MineBBS、bbsmc、MC 相关贴吧 / 知乎回答里，用「工具名 + 官网」的方式自然提及，别刷屏发链接。
- 论坛的帖子和资源已经对搜索引擎开放（2026/11 起）：论坛首页、板块页和帖子页做了**服务端渲染**（`forum/server/lib/ssr.js`），爬虫识别（`forum/server/lib/crawler.js`）命中 Baidu / Bing / Google / 搜狗 / 360 / Yandex 以及微信、Discord、Twitter 等链接预览机器人时，不再弹滑块，直接回一份带标题、描述、正文和面包屑结构化数据的完整 HTML；论坛子域的 `robots.txt` 已放行这三个只读地址、挡住后台和账号页，并提供论坛自己的 `sitemap.xml`（首页 + 全部板块 + 最近 1000 条主题，主题带 lastmod）。主站 `robots.txt` 也登记了论坛 sitemap。后续要在各家站长平台把 `https://forum.mcblockbox.top/sitemap.xml` 也提交一遍（见第二节）。联机大厅、意见反馈、个人主页等纯前端或账号页暂不参与收录，要放开时在论坛 robots.txt 里删掉对应 Disallow、再补对应的渲染页即可。

---

## 六、怎么判断有没有效果

- 收录：百度 / 必应搜 `site:mcblockbox.top`，能搜到首页 + 下载页就说明进去了（新站一般 3–7 天，慢的两三周）；论坛同理搜 `site:forum.mcblockbox.top`，帖子被收录后搜「帖子标题 + 方块盒子」应该能直接命中帖子页。
- 品牌词：搜「方块盒子」「BlockBox 启动器」看有没有自己的官网。
- 排名变化：百度搜索资源平台「流量与关键词」、必应后台「搜索性能」里能看到曝光 / 点击 / 平均排名，按周看趋势，别看单日。
- 结构化数据：<https://validator.schema.org/> 贴首页地址，确认没有报错。

排名是几个月的活：先保证**收录**，再靠**内容更新频率**和**外链**往上走。上线后第一周先把第二节的三家后台注册完、IndexNow 推一次。
