# 试麦员 Soundcheck · 单容器全栈（前端静态 + server.mjs + SSE）
# 安全设计：
#   ① COPY 白名单——只拷运行所需文件，.env / data / .git 由 .dockerignore 双重拦截，密钥永不入镜像
#   ② 密钥只经 Sealos Secret（运行时环境变量）注入，代码零硬编码（server.mjs process.env.*）
#   ③ 非 root 运行（node 内置用户）+ 只读根文件系统友好（数据全走 /data 持久卷）
#   ④ npm 源写死 npmmirror（白名单国内镜像，Sealos 构建环境不继承本机 npm config）
#   ⑤ node:22-alpine 固定 tag（Node ≥22 因 node:sqlite 依赖，见 package.json engines）
FROM docker.io/library/node:22-alpine

# npmmirror（阿里云运营，白名单镜像源）写进镜像层
RUN npm config set registry https://registry.npmmirror.com

WORKDIR /app

# 依赖层（先装后拷源码——package*.json 不变时命中缓存）
COPY package.json ./
# 本项目零运行时依赖，无 package-lock；有则一并拷（下一行通配在无 lock 时为空拷贝，不报错）
COPY package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# 运行文件白名单（顺序无关；docs/ 的使用指南供部署核对，不含敏感物）
COPY server.mjs hackathon.config.json ./
COPY lib/ lib/
COPY public/ public/
COPY scripts/ scripts/
COPY docs/ docs/

# 数据目录：Sealos 本地存储挂载点属主为 root，容器 node 用户写不进（线上实测 CrashLoop）
# → entrypoint 以 root 起飞 chown 后降权 node 运行（见 docker-entrypoint.sh）
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
VOLUME /data

# root 起飞（entrypoint chown /data 后 su 降权 node 运行 server）——容器进程实际以 node 跑
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# 健康检查（/api/health 无需鉴权、不消耗额度；wget 来自 alpine busybox）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4173/api/health || exit 1

EXPOSE 4173
# 容器内端口固定 4173（Sealos 侧外部端口映射与此无关）；HOST 默认读 config（127.0.0.1）容器内需显式 0.0.0.0
ENV PORT=4173 HOST=0.0.0.0
# SMOKE/LLM_MOCK 默认不设——线上跑真实链路；mock 仅烟测时以环境变量覆盖
# 启动命令在 docker-entrypoint.sh 内（chown /data → su node 降权运行）
