# Daily News Agent — 交付说明

**Feature**: `001-daily-news-agent`  
**Branch**: `daily-news-agent`  
**Agent 组**: Andy (`cli-with-muyu`, `ag-1782743582785-mmzfdy`)

## 主要交付

### 1. 知识日报抓取包 (`daily-news-agent/`)

运行于 Andy 容器 `/workspace/agent/daily-news-agent/`：

| 模块 | 功能 |
|------|------|
| `fetch-hn.ts` | HN Top 50，并发 ≤5，无 URL 丢弃 |
| `fetch-rss.ts` | OpenAI Blog + TechCrunch AI RSS |
| `normalize.ts` | URL 去重、条目归一化 |
| `time-window.ts` | 滚动 24h 窗口过滤 |
| `build-script-output.ts` | `ScriptResult` + 单行 JSON（task-script 契约） |
| `format-digest.ts` | 微信日报正文 + N<5 脚注（FR-004a/b） |
| `format-digest-cli.ts` | Agent 必须调用的格式化脚本入口 |
| `run-fetch.ts` | 预抓取编排，供 `daily-fetch.sh` 调用 |

**测试**: 33 vitest 用例（18 锁定 + fetch/编排/register 扩展）

### 2. NanoClaw 集成（复用既有能力，未改 host 核心）

| 集成点 | 实现 |
|--------|------|
| 定时 9:00 | `register-daily-news-task.ts` → `messages_in` + `recurrence='0 9 * * *'` |
| 预抓取 | `schedule_task` script → `daily-fetch.sh` |
| 微信推送 | `send_message(to="wechat-me")` + `setup-wechat-destination.sh` |
| 容器配置 | `setup-andy-container-config.sh`（opencode / deepseek-v4-pro / rss-parser） |
| 微信 Channel | `src/channels/wechat.ts`（add-wechat skill 适配） |

### 3. 运维脚本

- `scripts/daily-fetch.sh` — 定时 task 预抓取
- `scripts/format-digest.sh` — LLM 摘要后格式化正文
- `scripts/setup-wechat-destination.sh` — 微信 wire + destination
- `scripts/setup-andy-container-config.sh` — 容器 LLM/npm 配置
- `scripts/verify-daily-news-task.ts` — 定时任务验收（repo 根）

### 4. Agent 指令

- `AGENT_INSTRUCTIONS.md` — 可合并至 `CLAUDE.local.md`

## Spec 对齐

- FR-001–003, 007–009, 010: ✅ 代码 + 单测
- FR-004–006, 011–012: ✅ 设计 + 脚本/配置（E2E 需微信扫码后验证）
- 无新增 SQLite 表（FR-007/011）

## 合并后操作者检查清单

```bash
bash groups/cli-with-muyu/daily-news-agent/scripts/setup-andy-container-config.sh
bash groups/cli-with-muyu/daily-news-agent/scripts/setup-wechat-destination.sh
pnpm exec ncl groups restart --id ag-1782743582785-mmzfdy --rebuild
cd groups/cli-with-muyu/daily-news-agent && npm test
pnpm run chat "立即执行一次 AI 技术日报并推送到 wechat-me"
```
