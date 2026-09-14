#!/bin/sh
# 启动入口：修复 /data 属主（Sealos 本地存储挂载目录默认 root:root，容器以 node 用户运行写不进去
# —— 线上实测 CrashLoopBackOff 于 db.mjs DatabaseSync）。
# 模式：root 起飞 → chown /data → su 降权 node 运行 server（su 由 alpine busybox 提供）
set -e

if [ -d /data ] && [ "$(id -u)" = "0" ]; then
  chown -R node:node /data 2>/dev/null || true
  # root 启动时降权；非 root（本地直接 docker run --user node）直接执行
  exec su node -s /bin/sh -c 'exec node --no-warnings server.mjs'
fi

# 非 root 或无 /data：原样启动
exec node --no-warnings server.mjs
