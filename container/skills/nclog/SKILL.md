---
name: nclog
description: NanoClaw 本地日志查询工具。当 agent 需要查看自身日志、排查 NanoClaw 运行问题、查看消息处理链路、排查断连/compaction/IPC 问题时使用。触发词："查日志"、"看日志"、"nanoclaw 日志"、"nclog"、"自己的日志"、"查一下你的日志"。
---

# NanoClaw 日志查询 Skill

查询 NanoClaw 主进程的 JSON 日志，支持时间窗口、群组、日志级别、关键词过滤。

## 日志位置

- 主日志：`/Users/dajay/AI_Workspace/nanoclaw/logs/nanoclaw.log`（当前活跃）
- 轮转归档：`.log.1`、`.log.2` ... `.log.6`（10MB 轮转，最多 7 个归档）
- 总存储量：约 70MB，覆盖数天的完整日志
- Agent 运行日志：`/Users/dajay/AI_Workspace/nanoclaw/groups/*/logs/agent-*.log`

## 日志格式

每行一条 JSON（ndjson），标准字段：

```json
{
  "level": "info",
  "time": "2026-05-01T05:31:12.984Z",
  "pid": 332,
  "msg": "[card] 飞书卡片创建成功",
  "traceId": "97222d49",
  "chatJid": "fs:oc_0a34db4c63283dc7f75589cbb4a02bda",
  "groupFolder": "feishu_main"
}
```

## 使用方法

用 `query.sh` 脚本查询。脚本位于本 skill 目录：

```bash
NCLOG="node /Users/dajay/AI_Workspace/nanoclaw/container/skills/nclog/query.mjs"

# 查最近 5 分钟的日志
$NCLOG --since "5min"

# 查特定群组的日志
$NCLOG --group feishu_main --since "1h"

# 查 error 及以上级别
$NCLOG --level error

# 按关键词过滤 msg 字段
$NCLOG --grep "compaction|compact|Archived"

# 查特定 traceId
$NCLOG --trace abc12345

# 组合查询：最近 30 分钟，feishu_main 群，error 级别
$NCLOG --since "30min" --group feishu_main --level error

# 查 agent 运行日志（按时间排序最新的 N 个）
$NCLOG --agent-logs feishu_main --last 5

# 包含轮转归档文件
$NCLOG --all --grep "panic|fatal"

# 输出最近 N 条（默认 50）
$NCLOG --last 100
```

## 参数说明

| 参数 | 说明 | 示例 |
|------|------|------|
| `--since` | 时间窗口起点（GNU date 格式） | `"5 minutes ago"`, `"2026-05-01T05:00:00Z"` |
| `--until` | 时间窗口终点 | `"1 hour ago"`, `"2026-05-01T06:00:00Z"` |
| `--group` | 按 groupFolder 过滤 | `feishu_main`, `fs_oc_*` |
| `--level` | 最低日志级别 | `debug`, `info`, `warn`, `error`, `fatal` |
| `--grep` | msg 字段正则匹配 | `"IPC\|cross-group"`, `"compaction"` |
| `--trace` | 按 traceId 过滤 | `abc12345` |
| `--all` | 包含所有轮转归档文件 | （无值） |
| `--last` | 输出最后 N 条（默认 50） | `100`, `200` |
| `--agent-logs` | 查看指定群组的 agent 运行日志 | `feishu_main` |
| `--raw` | 输出原始 JSON（不做格式化） | （无值） |
| `--count` | 只输出匹配条数 | （无值） |
| `--stats` | 按级别统计条数 | （无值） |

## 常用查询场景

### 排查 agent 断连 / compaction
```bash
$NCLOG --grep "compact\|Archived\|preCompact\|context.management" --since "2 hours ago"
```

### 排查消息处理链路
```bash
$NCLOG --trace <traceId> --all
```

### 查看 IPC 通信
```bash
$NCLOG --grep "\\[ipc\\]\|\\[cross-group\\]" --since "30 minutes ago"
```

### 查看定时任务相关
```bash
$NCLOG --grep "\\[cron\\]\|schedule\|timer" --since "1 hour ago"
```

### 日志统计
```bash
$NCLOG --since "1 hour ago" --stats
```
