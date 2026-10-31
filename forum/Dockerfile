# 方块盒子论坛 · 生产镜像
# 无第三方依赖，所以镜像很薄；数据与上传文件都放在 /app/data 卷里
FROM node:22-alpine

WORKDIR /app

# 只拷运行需要的文件
COPY package.json ./
COPY server ./server
COPY web ./web
COPY scripts ./scripts
COPY docs ./docs

# 以固定 uid/gid 1000 的非 root 用户运行，方便 bind mount 时对齐权限
RUN mkdir -p /app/data/uploads \
 && addgroup -g 1000 -S forum \
 && adduser -u 1000 -S forum -G forum \
 && chown -R forum:forum /app/data

USER forum

ENV HOST=0.0.0.0 \
    PORT=3210 \
    DB_PATH=/app/data/forum.db \
    UPLOAD_DIR=/app/data/uploads \
    LOG_REQUESTS=1

EXPOSE 3210
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
