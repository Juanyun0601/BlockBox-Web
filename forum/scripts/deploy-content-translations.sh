#!/usr/bin/env bash
# 内容翻译接口部署脚本：把本次改动的 7 个文件传上服务器并重启服务。
# 用法：bash scripts/deploy-content-translations.sh
# 密钥默认用 ~/.ssh/blockbox_deploy_ed25519（与 GitHub Actions 部署同一把）。
# 注意：正式部署建议直接 push 到 main 让 Actions 全量同步；本脚本用于只更新这几个文件的快速热修。
#
# 部署内容（2026-11-21 新增「创建翻译 / 完善翻译」）：
#   server/routes/content-translations.js   新路由（公开查询 / 我的提交 / 提交翻译 / 管理审核）
#   server/index.js                         注册新路由
#   server/schema.sql                       content_translations 建表（服务启动时自动执行）
#   web/admin-translations.html             管理后台「翻译」页
#   web/assets/page-admin.js                管理后台页签与审核界面
#   web/assets/forum.css                    审核页样式
#   docs/API.md                             接口文档
set -euo pipefail

TARGET="${TARGET:-deploy@202.181.26.188}"
SSH_PORT="${SSH_PORT:-3220}"
KEY="${KEY:-$HOME/.ssh/blockbox_deploy_ed25519}"
REMOTE_DIR="${REMOTE_DIR:-/opt/blockbox-forum}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"

FILES=(
  "server/routes/content-translations.js"
  "server/index.js"
  "server/schema.sql"
  "web/admin-translations.html"
  "web/assets/page-admin.js"
  "web/assets/forum.css"
  "docs/API.md"
)

echo "==> 预检：服务器健康状态"
ssh -p "$SSH_PORT" -i "$KEY" -o IdentitiesOnly=yes "$TARGET" "curl -s --max-time 5 http://127.0.0.1:3210/api/health"

echo "==> 上传文件"
for file in "${FILES[@]}"; do
  echo "  $file"
  scp -P "$SSH_PORT" -i "$KEY" -o IdentitiesOnly=yes "$HERE/$file" "$TARGET:$REMOTE_DIR/$file"
done

echo "==> 重启服务"
ssh -p "$SSH_PORT" -i "$KEY" -o IdentitiesOnly=yes "$TARGET" "
  sudo /usr/bin/systemctl restart blockbox-forum
  sleep 2
  systemctl is-active blockbox-forum
"

echo "==> 验证新接口"
sleep 1
curl -s "https://forum.mcblockbox.top/api/content-translations?source=curseforge&project_id=0&lang=zh-CN" || true
echo
echo "部署完成。建表在服务首次重启时自动执行（content_translations）。"
