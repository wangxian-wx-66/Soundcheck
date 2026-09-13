#!/usr/bin/env bash
# 试麦员 Soundcheck · 一键本地启动
# 用法：./start.sh          （默认端口 4173，读 .env 凭证）
#       PORT=3000 ./start.sh （指定端口）
# 依赖：Node >= 22（SQLite 内置模块）；凭证从 .env 或环境变量读取（服务端自动加载，无需 source）
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-4173}"
HOST="${HOST:-127.0.0.1}"

# ---- 前置检查 ----
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 node，请先安装 Node >= 22" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "✗ Node 版本过低（$(node -v)，需要 >= 22，内置 node:sqlite）" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "⚠ 未找到 .env（ZHIHU_ACCESS_SECRET / DEEPSEEK_API_KEY 未配置时，检索与 LLM 不可用，仅能看页面）"
  echo "  模板参考：cp .env.example .env 后填入真实 key"
fi

mkdir -p data

# ---- 启动（前台运行，Ctrl+C 退出）----
echo "→ 试麦员 Soundcheck 启动中：http://${HOST}:${PORT}"
exec node --no-warnings server.mjs
