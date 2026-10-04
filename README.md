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

> 注意：`cube.png` / `cube-sm.png` 是从 `promo/poster/cube.png` 等比缩放的 web 优化副本，内容与官方素材一致；若官方 logo 更新，请重新覆盖 `assets/img/` 下的对应文件。

## 上线前需要替换的占位链接（index.html）

| 位置 | 现状 | 说明 |
| --- | --- | --- |
| 导航 GitHub 按钮 | `href="#"` | 换成仓库地址，如 `https://github.com/<用户名>/BlockBox` |
| 页脚「GitHub 仓库 / 问题反馈 / 参与贡献 / 更新日志」 | `href="#"` | 同上 |
| 下载区「立即下载」按钮 | 已配置 | 跳转飞书 wiki：<https://icna5xkz6qxe.feishu.cn/wiki/HzUiwnFYmihLX1kufKQcU4sknBf> |

## 维护提示

- 主题色：`assets/style.css` 顶部 `:root` 中 `--g800`（主绿，与启动器 ThemeManager 一致）、`--lime` 等。
- 口径约定：AI 不标注具体模型数量；插件为**官方出品、需安装**，不写"内置"；投影编辑器是插件且未调好，**不上官网**；实例助手功能以 `C-BlockBox/components/InstanceAssistantWindow.h` 为准（性能监控 / AI 助手 / 中文指令注入 / 联机 / 模组资源管理 / Java 管理）。
- 独有功能数据（19 种 AI Agent 工具 / 9 款官方插件 / 对比表）整理自 `方块盒子vsPCL_HMCL对比分析.md` 与项目知识图谱，功能变化时同步更新。
- 已适配 `prefers-reduced-motion`：开启「减少动效」的用户会看到静态版 AI 对话。
