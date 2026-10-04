# 方块盒子 BlockBox 官网

浅色 · 绿色主题（品牌主绿 `#2E7D32`）· 现代 · 纯静态，零外部依赖，双击 `index.html` 即可打开，也可部署到任意静态托管（GitHub Pages / Vercel / 服务器）。

## 文件结构

```
方块盒子官网/
├── index.html        # 单页官网（导航/英雄区/核心功能/独特魅力/横向对比/下载/页脚）
└── assets/
    ├── style.css     # 全部样式（CSS 变量定义在 :root，可改主题色）
    ├── main.js       # 交互：滚动入场、数字计数、AI 对话演示、立方体视差
    └── img/          # 品牌 logo，取自现有素材（不自创）
        ├── logo.png      # 立方体 + 字标（源：C-BlockBox/Images/logo.png），导航与页脚
        ├── cube.png      # 品牌立方体（源：promo/poster/cube.png，缩至 640px 高），英雄区
        ├── cube-sm.png   # 上图 64px 版，对比表表头
        └── icon.ico      # 应用图标（源：C-BlockBox/Images/icon.ico），网站 favicon
```
