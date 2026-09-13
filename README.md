# 试麦员 Soundcheck

> 开麦前，先试麦 —— 知乎答主发布前的「信息增量体检」

知乎黑客松 2026 校园新锐季 · 知识炼金场赛道。在 AI 生成内容泛滥的时代，帮真人创作者在按下发布键之前预演这次开麦：已有回答覆盖了什么、你的真正增量在哪、评论区会怎么杠你。

## 双模式

- **选题雷达**（写作前）：输入问题 → 论点版图 + 尚缺好回答的空白方向
- **开麦评审**（发布前）：粘贴草稿 → 覆盖分析 / 增量定位 / 争议预演 三段报告

证据四层链：L1 question answers 标杆序 · L2 定向补强搜索 · L3 真实精选评论 · L4 AI 转述（末级，明示标注）。

## 技术栈

Node ≥ 22，**零 npm 依赖**（标准库实现全部功能：`node:sqlite` / `node:http` / fetch）。

| 模块 | 职责 |
|---|---|
| `lib/db.mjs` | SQLite 三表（search_cache 24h / qa_cache 7d / reports LRU 1000）+ WAL + 自检重建 |
| `lib/zhihu.mjs` | 知乎开放平台适配层（搜索/问题回答/热榜/额度），缓存 + single-flight + 限流重试 |
| `lib/llm.mjs` | DeepSeek（OpenAI 兼容）function calling + JSON mode + 解析重问 |
| `lib/gate.mjs` | 并发闸门：活跃分析 ≤6，zhihu/llm 上游在飞各 ≤4 |
| `lib/pipeline.mjs` | 主审 Agent 管线：run_id 贯穿、SSE 事件序号、工具预算 6 次、双熔断 |
| `server.mjs` | HTTP + SSE 服务（含官方 OAuth 脚手架路由） |

## 快速开始

```bash
npm test          # 单元 + 集成测试（mock，零额度消耗）
npm run smoke     # HTTP 烟测（SMOKE=1 + LLM_MOCK=1，零额度）
npm start         # 启动 http://127.0.0.1:4173/
```

环境变量（模板见 `.env.example`，本地用系统环境变量注入，**不落文件**）：

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | LLM 大脑（deepseek-flash） |
| `ZHIHU_ACCESS_SECRET` | 知乎开放平台数据接口 |
| `ZHIHU_OAUTH_APP_KEY` | 知乎 OAuth App Key（部署平台 Secret 注入） |
| `LLM_MOCK=1` / `SMOKE=1` | 冒烟模式（mock LLM / mock 知乎接口） |

未配置密钥时服务可启动，分析走降级路径（无检索、纯推导，报告内明示）。

## API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/analyze` | 发起分析（mode: radar/review）→ runId |
| GET | `/api/run/:runId/events` | SSE 事件流（Last-Event-ID 续传 + 15s 心跳） |
| GET | `/api/report/:runId` | 三段报告回访 |
| GET | `/api/hot` | 知乎热榜 top10（选题雷达入口） |
| GET | `/api/health` / `/api/stats` | 健康检查 / 运行时状态 |

## 凭证安全

- 密钥一律环境变量运行时注入，代码只读 `process.env.*`，仓库无任何明文凭证
- `.env.example` 仅含变量名模板；`.env` / `*.key` / `secrets/` 已被 `.gitignore` 排除
- 提交前自动扫描：`git config core.hooksPath .githooks` 启用 pre-commit 钩子（检测 API key/Bearer/私钥块模式，命中即阻断）
- SQLite 数据库（`/data`）为可再生缓存，不入库

## 目录

```
lib/        后端模块          public/    前端（设计中）
scripts/    部署/烟测脚本     tests/     node:test 测试
docs/       开发计划书        devlog/    开发日志与实测原始数据（原创性核验材料）
```
