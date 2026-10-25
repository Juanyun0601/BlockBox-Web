# 方块盒子 BlockBox 官网

浅色 · 绿色主题（品牌主绿 `#2E7D32`）· 现代 · 纯静态，零外部依赖，双击 `index.html` 即可打开，也可部署到任意静态托管（GitHub Pages / Vercel / 服务器）。

## 文件结构

```
方块盒子官网/
├── index.html        # 单页官网（导航/英雄区/核心功能/独特魅力/横向对比/下载/页脚）
├── download.html     # 下载页（最新版 beta5 + 历史版本 + 官方插件包；自动识别当前系统与架构）
├── docs.html         # 插件开发文档（开发者平台）
├── CNAME             # 自定义域名 blockbox.cc.cd
├── css/              # 文档页独立样式（含语言切换器样式）
├── js/               # 文档页脚本（导航交互）
└── assets/
    ├── style.css     # 首页/下载页全部样式（CSS 变量定义在 :root，可改主题色）
    ├── main.js       # 交互：滚动入场、数字计数、AI 对话演示、立方体视差
    ├── i18n.js       # 多语言运行时：判定语言、按需加载字典、替换文案、注入语言切换器
    ├── i18n/         # 各语言文案字典（构建产物，勿手改）
    │   ├── zh-TW.js  # 繁體中文
    │   ├── en.js     # English
    │   ├── es.js     # Español
    │   ├── ja.js     # 日本語
    │   └── ru.js     # Русский
    └── img/          # 品牌 logo，取自现有素材（不自创）
        ├── logo.png      # 立方体 + 字标（源：C-BlockBox/Images/logo.png），导航与页脚
        ├── cube.png      # 品牌立方体（源：promo/poster/cube.png，缩至 640px 高），英雄区
        ├── cube-sm.png   # 上图 64px 版，对比表表头
        └── icon.ico      # 应用图标（源：C-BlockBox/Images/icon.ico），网站 favicon
```

## 多语言

默认简体中文，支持繁體中文 / English / Español / 日本語 / Русский。

- **切换方式**：顶部导航最左侧的下拉框；选择结果存在 `localStorage`，下次访问自动生效。
- **分享固定语言**：在任意页面 URL 后加 `?lang=`，取值 `zh-CN` / `zh-TW` / `en` / `es` / `ja` / `ru`，
  例如 `https://blockbox.cc.cd/download.html?lang=en`。
- **工作原理**：`assets/i18n.js` 在 `<head>` 里同步插入当前语言的字典（简体中文不加载任何文件），
  页面无需 `data-i18n` 标记——脚本按「元素整句 innerHTML」和「纯文本节点」两种粒度查表替换；
  `MutationObserver` 会补翻由脚本动态插入的文字（系统识别结果、AI 对话演示等）。
- **翻译范围**：`<title>`、`<meta name="description">`、`aria-label` / `title` / `alt` / `placeholder`、
  正文与按钮；`<code>`、`<pre>` 里的代码与命令保持原样。
- **改文案**：改 `<code>zh-CN` 原文后，需要同步更新 `assets/i18n/*.js` 里对应的键（键就是中文原文）。
- **加语言**：在 `assets/i18n.js` 的 `LANGS` 数组里加一项，再放一份 `assets/i18n/<code>.js`
  （形如 `window.BB_I18N_DICT = { "中文原文": "译文" }`）。

## 公告文件（客户端首页公告栏）

`announcement.json` 是启动器首页公告栏的数据源，客户端会请求
`https://blockbox.cc.cd/announcement.json`（约 10 分钟内只取一次），
拿到后缓存到本地，断网时继续显示上一次的内容。

**一条公告 = 一段文字 + 一个可选的跳转链接**，多条公告在首页会分页轮播（鼠标移上去暂停，可点左右箭头切换）。
修改后直接上传覆盖同名文件即可，客户端下次进首页自动生效，无需发版。

```json
{
  "version": 1,
  "updated": "2026-10-25",
  "announcements": [
    {
      "text": "公告正文，一行显示，太长客户端会自动省略成「…」",
      "link": "https://blockbox.cc.cd/download.html",
      "date": "2026-10-25"
    },
    { "text": "这条没有链接，点击不会有反应" }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `text` | 是 | 公告文字；空文字的条目会被忽略 |
| `link` | 否 | 点击跳转地址，只支持 `http` / `https`，也可写 `/download.html` 这样的站内相对路径；不写则不可点击 |
| `date` | 否 | 发布日期，仅作记录，界面不单独显示 |
| `id` | 否 | 稳定标识，不写时由文字 + 链接自动生成 |
| `enabled` | 否 | 写 `false` 可临时下线这条公告，不必删除 |

- 数组顺序就是首页展示顺序，想把哪条排第一就放到最前面。
- 最多展示 20 条，超出部分客户端不读取。
- 也可以只写一个纯字符串数组 `["第一句公告", "第二句公告"]`（都没有链接）。
- 公告全部删掉（`"announcements": []`）时，首页公告栏会整条隐藏。

## 许可

本仓库的页面、样式与脚本以 [GNU 通用公共许可证第 3 版（GPL-3.0）](LICENSE) 发布，© Juanyun0601。
修改后再分发时，请保留版权声明并以 GPL-3.0 公开源码；页面中提到的第三方库、素材与参考项目仍遵循各自协议。
