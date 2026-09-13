---
name: zhihu-hackathon-dev
description: 试麦员 Soundcheck 项目开发时使用：调用知乎开放平台 API（搜索/热榜/直答/问题回答/OAuth 用户数据/额度查询）、接入或调试知乎 OAuth 登录、区分三种凭证（App ID / OAuth App Key / Access Secret）、配置 Sealos 部署凭证、核对黑客松提交要求或 API 红线时。涉及 zhihu CLI 调用、X-OAuth-Token、回调地址、quota 额度、me content 权限边界等话题时也使用。
---

# 知乎黑客松开发速查（试麦员 · Soundcheck）

本 skill 是官方文档的项目级沉淀。完整文档在 `c:\Soundcheck\.trae\skills\zhihu\references\`（官方 0.7.2-beta；2026-09-13 按官方指引删除旧包重装，新包拖入 `.trae\skills\zhihu\` 后生效），本文件只留开发时高频使用的事实与本项目实况。

## 一、CLI 快速调用

- 二进制：`C:\Users\DELL\AppData\Local\ZhihuCLI\current\zhihu-cli.exe`（0.6.0，Access Secret 已配置于系统凭证库）
- 状态自检：`powershell -ExecutionPolicy Bypass -File c:\Soundcheck\.trae\skills\zhihu\scripts\run.ps1 status`
- 不确定参数时先跑 `<CLI> <command> --help`；`<CLI> capabilities` 输出机器可解析能力清单

```powershell
$cli = "C:\Users\DELL\AppData\Local\ZhihuCLI\current\zhihu-cli.exe"
& $cli search zhihu --query "机器学习该怎么入门" --count 10
& $cli search global --query "..." --count 10        # 全网，Filter 支持 host/publish_time，count≤20
& $cli hot --limit 20                                 # 热榜，仅 --limit 1-30，无时间范围参数
& $cli answer --query "..."                           # 直答（OpenAI 兼容，无 tools，仅彩蛋）
& $cli question recommend --query "主题" --count 5    # 问题发现（画像或主题）
& $cli question answers --question-url "https://www.zhihu.com/question/123" --limit 20  # 回答摘要（标杆序）
& $cli quota                                           # 额度查询，不消耗额度（运行时熔断数据源）
```

## 二、开放能力与额度（实测口径 2026-09-12）

| 能力 | API ID | 实测额度/天 | 本项目用途 |
|---|---|---|---|
| 知乎搜索（富字段：VoteUp/Authority/CommentInfoList/RankingScore） | `zhihu_search` | **5,000**（实名后；手册 1000 为保守口径） | 主管线核心（≤6 次/分析） |
| 全网搜索 | `global_search` | 5,000 | 备用 |
| 热榜 | `hot_list` | 100（字段薄，仅 Title/Url/Summary） | P2 机会榜 |
| 问题回答摘要（社区标杆序；字段薄：无赞数/作者） | `question_answers` | **100（最紧约束）** | L1 证据层，qa_cache TTL 7 天 |
| 直答 | `zhida_openai` | **5,000（9/13 复测官方放宽，原 100）** | L4 末级证据 + 彩蛋（生成式转述定位不变） |
| 创作能力（me content/comments/stats；question recommend 共用） | `creator` | 100 | P3 复盘 |
| 用户数据（OAuth 用户列表接口） | `user_data` | 10,000 | OAuth 登录用户五项接口 |
| 知识库 / 小工具 | `knowledge` / `tools` | 500 / 10 | 不用 |

同账号所有 Access Secret 共享额度池。`quota` 计数与实际消耗对账分毫不差（9/12 实测）。

## 三、凭证三件套（本项目实况，勿混淆）

| 凭证 | 用途 | 本项目存放 |
|---|---|---|
| **App ID**（公开） | 标识 OAuth 应用 | `hackathon.config.json` → `oauth.appId` = `399` |
| **OAuth App Key** | 后端换 OAuth Token（`/access_token`） | 用户环境变量 `ZHIHU_OAUTH_APP_KEY`；Sealos 部署时注入同名 Secret |
| **Access Secret**（开放平台） | 业务接口 `Authorization: Bearer` | CLI 凭证库（本机）；Sealos 注入 `ZHIHU_ACCESS_SECRET` |

串位是最常见翻车点：App ID 是短数字，不是 App Key；App Key 不是 Access Secret。`/api/oauth/status` 的 `credentialWarnings` 会自动检测串位。

## 四、OAuth 接入要点（黑客松专属规则）

- **回调**：赛事页面登记值必须与应用 `redirect_uri` 完全一致（协议/域名/端口/路径/尾部斜杠）。当前赛事页面登记为 `http://127.0.0.1`——**本地地址无法完成真实登录**；部署 Sealos 后须在赛事页面改登记 `https://<域名>/auth/callback`，并运行 `node c:\Soundcheck\scripts\configure_callback.mjs --project-dir c:\Soundcheck --redirect-uri <回调地址>` 同步项目配置（脚本已从旧包迁至项目 `scripts/`，仅依赖 Node 内置模块）
- **state 已支持原样透传**（旧文档「可能不返回 state」已过时）：必须用密码学随机数生成、绑定会话、回调校验+原子消费。脚手架 `lib/oauth.mjs` 已实现
- 授权 URL：`GET https://openapi.zhihu.com/authorize?redirect_uri=...&app_id=...&response_type=code&state=...`；回调参数为 `authorization_code`（后端兼容 `code`）；Token 交换 `POST https://openapi.zhihu.com/access_token`（表单字段 `code`）
- **用户基础信息**：`GET https://openapi.zhihu.com/user`，仅需 `Authorization: Bearer <OAuth access_token>`（无需 Access Secret）。`uid` 为 int64 超 JS 安全整数，必须无损解析为字符串
- **用户数据五项接口**（需 `Authorization: Bearer <Access Secret>` + `X-OAuth-Token: <OAuth token>` + `X-Request-Timestamp: <Unix秒>`，域名 `developer.zhihu.com`）：
  1. 创作列表 `/api/v1/user/contents`（标题+摘要，无全文）
  2. 关注 `/api/v1/user/followees`
  3. 收藏夹 `/api/v1/user/favlists`
  4. 收藏内容 `/api/v1/user/favlist_contents`（依赖 favlists 返回的 UrlToken）
  5. 近期收藏 `/api/v1/user/collections`
- **权限红线（0.7.2 官方文档明确）**：`me content / me comments / me stats / me content-stats` 四项**只支持 Access Secret 所属账号，不能通过 X-OAuth-Token 代查其他用户**——OAuth 登录用户的「全文复盘」不可行，复盘模式上限为摘要级
- OAuth Token 只存服务端会话（HttpOnly Cookie 承载应用会话 ID）；用户必须亲自点击知乎授权页最终确认

## 五、黑客松专属内容 API（免鉴权，可选彩蛋）

知乎故事/知乎知识列表与详情，`https://api.zhihu.com/km-indep-home/hackathon/v2/{story|knowledge}/list`，详情共用 `story/{work_id}`。与 OAuth 相互独立。详见 `.trae/skills/zhihu/references/hackathon-content-api.md`。

## 六、红线与提交检查

- 禁止批量爬取、高频无意义调用、刷屏灌水；应用层必须做缓存与请求去重（本项目：search_cache TTL 24h / qa_cache TTL 7d / single-flight）
- 凭证不得出现在：代码仓库、前端响应、URL、日志、截图、视频、Agent 输出
- 提交前 7 项自查（浓缩）：①公网 Demo 可完成核心流程 ②项目信息完整 ③仓库/视频评委可访问 ④回调与赛事页面登记一致 ⑤凭证零泄露 ⑥接口失败/额度耗尽/空数据有真实降级提示 ⑦「代码已完成」≠「线上已可用」，须实际运行验证

## 七、官方文档索引（.trae/skills/zhihu/references/）

| 文件 | 内容 |
|---|---|
| `http-api.md` | 搜索/热榜/直答/问题/知识库/额度 HTTP 字段定义 |
| `user-api.md` | 用户数据 API（OAuth 用户列表接口） |
| `hackathon-oauth.md` | 黑客松 OAuth 接入（本 skill §四的来源） |
| `hackathon-user-profile-api.md` | `/user` 基础信息接口字段 |
| `hackathon.md` | 赛程/报名/提交要求 |
| `creator.md` | 创作能力（本人身份限制） |
| `cli.md` / `open-platform.md` / `oauth.md` / `mcp.md` | CLI 全命令 / 平台指南 / 通用 OAuth / MCP |

资源：开放平台 https://developer.zhihu.com/ ｜ 文档 https://developer.zhihu.com/docs?key=zhihu_cli ｜ 项目大厅 https://www.zhihu.com/hackathon?activity_code=zhihu_hackathon_2026_p2
