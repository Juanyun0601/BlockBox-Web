#!/usr/bin/env bash
# 开启「公开资源走 CDN」：给 cdn 域名申请证书 → 开 443 → 让论坛页面把 /assets、/uploads 指向 CDN
#
# 前提：cdn.mcblockbox.top 已经在 Cloudflare 里加好（A 记录指向这台服务器，橙色云 / 灰色云都行），
# 否则域名解析不到、证书申请不下来。
#
# 用法（服务器上，root）：
#   bash /opt/blockbox-forum/deploy/开启CDN.sh
set -euo pipefail

CDN_DOMAIN="${CDN_DOMAIN:-cdn.mcblockbox.top}"
FORUM_DOMAIN="${FORUM_DOMAIN:-forum.mcblockbox.top}"
APP_DIR="/opt/blockbox-forum"
ACME_ROOT="/var/www/blockbox"
NGINX_SITE="/etc/nginx/sites-available/cdn-mcblockbox"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "1/6 检查 DNS"
if ! getent hosts "$CDN_DOMAIN" >/dev/null; then
  die "$CDN_DOMAIN 还没有解析。请先在 Cloudflare 加一条 A 记录：名称 cdn，内容 202.181.26.190"
fi
getent hosts "$CDN_DOMAIN" | head -2

say "2/6 检查源站 ACME 验证路径"
mkdir -p "$ACME_ROOT/.well-known/acme-challenge"
echo "ok-$(date +%s)" > "$ACME_ROOT/.well-known/acme-challenge/cdn-check.txt"
probe="$(curl -s -m 10 -H "Host: $CDN_DOMAIN" "http://127.0.0.1/.well-known/acme-challenge/cdn-check.txt" || true)"
rm -f "$ACME_ROOT/.well-known/acme-challenge/cdn-check.txt"
[ -n "$probe" ] || die "源站在 Host=$CDN_DOMAIN 下没有提供 ACME 验证文件，检查 $NGINX_SITE 是否启用"
echo "源站验证正常"

say "3/6 申请证书（Let's Encrypt，HTTP-01）"
if [ -f "/etc/letsencrypt/live/$CDN_DOMAIN/fullchain.pem" ]; then
  echo "证书已存在，跳过申请"
else
  certbot certonly --webroot -w "$ACME_ROOT" -d "$CDN_DOMAIN" \
    --non-interactive --agree-tos --keep-until-expiring
fi

say "4/6 写 nginx 配置（80 直接回源 + 443 回源）"
cat > "$NGINX_SITE" <<EOF
# 公开资源 CDN 域名：$CDN_DOMAIN（由 deploy/开启CDN.sh 生成）
server {
    listen 80;
    listen [::]:80;
    server_name $CDN_DOMAIN;

    location /.well-known/acme-challenge/ {
        root $ACME_ROOT;
    }

    # 很多 CDN 面板的「回源协议」只能选 http，而且不回跟 301，所以这里直接回源，
    # 不跳 https；真正的 https 由 CDN 边缘负责。
    location / {
        proxy_pass http://blockbox_forum;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $CDN_DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$CDN_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$CDN_DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # 与论坛主域同一套回源逻辑：/assets、/uploads 由论坛进程直接发，
    # 它已经带上 30 天 immutable 缓存和 Access-Control-Allow-Origin: *
    location / {
        proxy_pass http://blockbox_forum;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    access_log /var/log/nginx/cdn.access.log;
    error_log  /var/log/nginx/cdn.error.log;
}
EOF
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/cdn-mcblockbox
nginx -t
systemctl reload nginx
echo "nginx 已重载"

say "5/6 打开论坛的 CDN 开关"
touch "$APP_DIR/.env"
if grep -q '^CDN_BASE=' "$APP_DIR/.env"; then
  sed -i "s|^CDN_BASE=.*|CDN_BASE=https://$CDN_DOMAIN|" "$APP_DIR/.env"
else
  printf '\n# 公开资源走 CDN（/assets 与 /uploads）\nCDN_BASE=https://%s\n' "$CDN_DOMAIN" >> "$APP_DIR/.env"
fi
grep '^CDN_BASE=' "$APP_DIR/.env"
systemctl restart blockbox-forum
sleep 2
systemctl is-active blockbox-forum

say "6/6 验证"
curl -s -m 10 -o /dev/null -w "页面 %{http_code}\n" "http://127.0.0.1:3210/"
if curl -s -m 10 "http://127.0.0.1:3210/" | grep -q "https://$CDN_DOMAIN/assets/"; then
  echo "页面里的脚本样式已指向 https://$CDN_DOMAIN ✓"
else
  echo "页面里还没看到 CDN 域名，检查 journalctl -u blockbox-forum -n 20"
fi
curl -sI "https://$FORUM_DOMAIN/assets/forum.css" | grep -i 'cache-control\|access-control' || true

cat <<EOF

完成。CDN 面板那边需要（只做一次，换域名才要重来）：
  - 域名绑定：域名 $CDN_DOMAIN / 源站IP 202.181.26.190 / 回源协议 http
  - DNS：$CDN_DOMAIN 做 CNAME 到面板给的地址，代理开关保持关闭
  - 缓存设置：只缓存静态扩展名（css,js,svg,ico,png,jpg,jpeg,gif,webp,woff2），
    缓存时间 2592000 秒，强制缓存不勾——页面和 /api 永远不缓存
  - SSL 证书：面板只支持手工上传，把下面两个文件整段贴进去
      /etc/letsencrypt/live/$CDN_DOMAIN/fullchain.pem   → ssl证书内容
      /etc/letsencrypt/live/$CDN_DOMAIN/privkey.pem     → ssl证书密钥内容
    证书 90 天到期，续期后要重新贴一次

验证是否真的在缓存：
  curl -sI "https://$CDN_DOMAIN/assets/forum.css" | grep -i 'x-cache\\|cache-control'
  第一次 MISS，再刷两次出现 HIT 就对了
EOF
