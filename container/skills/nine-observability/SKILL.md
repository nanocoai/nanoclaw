---
name: nine-observability
description: Nine 平台线上问题排查 & 查日志（GlitchTip→Jaeger→Loki 5 步法）。触发：用户说"查日志"、"看日志"、"拉日志"、"Loki"、"Jaeger"、"GlitchTip"；描述 Nine 报错/超时/500/502/异常；提到 trace_id / span_id / GlitchTip issue ID (AGENT-*/GO-API-*)；涉及生产机 10.117.0.159 或测试机 10.117.5.134；提到 Grafana / OTEL / Sentry / knowledge.search 超时 / Qdrant 检索失败 / LLM 调用失败 / SSE 断开。
---

# Nine 线上问题排查 Skill

Nine 平台（Python backend + Go api）的标准排查路径。所有凭据已持久化在两台机器的 `/etc/profile.d/glitchtip.sh`，**不要**在本地 export token。

详细资料见 Wiki：`../../global/wiki/nine-observability-debug.md`（精选页）和 `../../global/wiki/sources/nine-observability-debug-guide.md`（完整原始指南）。

## 触发词

只要用户提到以下任一，就按本 skill 流程走：

- "Nine ... 报错 / 500 / 502 / 超时 / 失败"
- "有 trace_id 吗"、"查一下 trace_id=..."
- GlitchTip issue shortId（`AGENT-3`、`GO-API-7` 等）
- 机器 IP：`10.117.5.134`（测试）/ `10.117.0.159`（生产）
- "查 GlitchTip / Jaeger / Loki / Grafana"
- 关键字："knowledge.search 超时"、"Qdrant 检索失败"、"LLM 调用失败"、"SSE 断开"

## 5 步法

```
用户问题
  ↓
Step 1  拿 trace_id        ← 用户给 / GlitchTip issue / 时间窗口反查
  ↓
Step 2  Jaeger 取 span 树  ← 找出错 span + 服务归属
  ↓
Step 3  Loki 拉 trace 日志 ← 两端日志看上下文
  ↓
Step 4  GlitchTip 取 stack ← 如果是异常
  ↓
Step 5  回报               ← trace_id + 根因 + 建议修复 + 相关 PR
```

## 两套环境差异（必读）

| 项 | 测试机 | 生产机 |
|---|---|---|
| ssh host | `10.117.5.134` | `10.117.0.159` |
| GLITCHTIP_ORG | `dewu` | `-wn` |
| Python backend project slug | `agent` | `enterprise-ai-agent-backend` |
| Go API project slug | `go-api` | `go-api` |
| HTTP 命令 | `curl` | `gtcurl`（包 `--noproxy`，绕开 `HTTP_PROXY=127.0.0.1:20171`）|

**关键**：所有命令必须 `ssh root@HOST 'bash -lc "..."'`（`-lc` 触发 login shell，source profile.d 里的 env）。直接 `ssh root@HOST 'curl ...'` 拿不到 `$GLITCHTIP_TOKEN`。

## 命令模板（直接抄）

### A. 测试机一条龙（issue → trace_id → Jaeger → Loki）

```bash
# 1) GlitchTip issue → trace_id
ISSUE_ID=3
TRACE_ID=$(ssh root@10.117.5.134 "bash -lc 'curl -sS -H \"Authorization: Bearer \$GLITCHTIP_TOKEN\" \"\$GLITCHTIP_URL/api/0/issues/$ISSUE_ID/events/latest/\"'" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("contexts",{}).get("trace",{}).get("trace_id",""))')
echo "trace_id=$TRACE_ID"

# 2) Jaeger span 树
ssh root@10.117.5.134 "bash -lc 'curl -sS \"\$JAEGER_URL/api/traces/$TRACE_ID\"'"

# 3) Loki 日志
ssh root@10.117.5.134 "bash -lc '
  START=\$((\$(date +%s) - 3600)); END=\$(date +%s)
  curl -sS -G -u \"\$GRAFANA_USER:\$GRAFANA_PASSWORD\" \
    \"\$GRAFANA_URL/api/datasources/proxy/uid/loki/loki/api/v1/query_range\" \
    --data-urlencode \"query={service=~\\\".+\\\"} | json | trace_id=\\\"$TRACE_ID\\\"\" \
    --data-urlencode \"start=\${START}000000000\" \
    --data-urlencode \"end=\${END}000000000\" \
    --data-urlencode \"limit=200\"
'"
```

### B. 生产机一条龙（换 4 处：host / gtcurl / project slug / org）

```bash
ISSUE_ID=7
TRACE_ID=$(ssh root@10.117.0.159 "bash -lc 'gtcurl -sS -H \"Authorization: Bearer \$GLITCHTIP_TOKEN\" \"\$GLITCHTIP_URL/api/0/issues/$ISSUE_ID/events/latest/\"'" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("contexts",{}).get("trace",{}).get("trace_id",""))')
echo "trace_id=$TRACE_ID"

ssh root@10.117.0.159 "bash -lc 'gtcurl -sS \"\$JAEGER_URL/api/traces/$TRACE_ID\"'"

ssh root@10.117.0.159 "bash -lc '
  START=\$((\$(date +%s) - 3600)); END=\$(date +%s)
  gtcurl -sS -G -u \"\$GRAFANA_USER:\$GRAFANA_PASSWORD\" \
    \"\$GRAFANA_URL/api/datasources/proxy/uid/loki/loki/api/v1/query_range\" \
    --data-urlencode \"query={service=~\\\".+\\\"} | json | trace_id=\\\"$TRACE_ID\\\"\" \
    --data-urlencode \"start=\${START}000000000\" \
    --data-urlencode \"end=\${END}000000000\" \
    --data-urlencode \"limit=200\"
'"
```

### C. 列最近异常

```bash
# 测试机 - Python
ssh root@10.117.5.134 'bash -lc "curl -sS -H \"Authorization: Bearer \$GLITCHTIP_TOKEN\" \"\$GLITCHTIP_URL/api/0/projects/\$GLITCHTIP_ORG/agent/issues/?limit=5\""'

# 测试机 - Go
ssh root@10.117.5.134 'bash -lc "curl -sS -H \"Authorization: Bearer \$GLITCHTIP_TOKEN\" \"\$GLITCHTIP_URL/api/0/projects/\$GLITCHTIP_ORG/go-api/issues/?limit=5\""'

# 生产机 - Python（注意 slug 是 enterprise-ai-agent-backend，org 是 -wn）
ssh root@10.117.0.159 'bash -lc "gtcurl -sS -H \"Authorization: Bearer \$GLITCHTIP_TOKEN\" \"\$GLITCHTIP_URL/api/0/projects/\$GLITCHTIP_ORG/enterprise-ai-agent-backend/issues/?limit=5\""'
```

### D. 无 trace_id 反查（时间窗口 + level=error）

```bash
ssh root@10.117.5.134 "bash -lc '
  START=\$((\$(date +%s) - 1800))
  END=\$(date +%s)
  curl -sS -G -u \"\$GRAFANA_USER:\$GRAFANA_PASSWORD\" \
    \"\$GRAFANA_URL/api/datasources/proxy/uid/loki/loki/api/v1/query_range\" \
    --data-urlencode \"query={service=~\\\".+\\\"} | json | level=\\\"error\\\"\" \
    --data-urlencode \"start=\${START}000000000\" \
    --data-urlencode \"end=\${END}000000000\" \
    --data-urlencode \"limit=50\"
'"
```

### E. 关键字反查 trace_id

```bash
KEYWORD='Qdrant 检索失败'
ssh root@10.117.5.134 "bash -lc '
  START=\$(date -d \"1 hour ago\" +%s); END=\$(date +%s)
  curl -sS -G -u \"\$GRAFANA_USER:\$GRAFANA_PASSWORD\" \
    \"\$GRAFANA_URL/api/datasources/proxy/uid/loki/loki/api/v1/query_range\" \
    --data-urlencode \"query={service=~\\\".+\\\"} |~ \\\"$KEYWORD\\\"\" \
    --data-urlencode \"start=\${START}000000000\" \
    --data-urlencode \"end=\${END}000000000\"
'"
```

## 常见踩坑（按概率排序）

1. **trace_id 是 `<none>`** → 后台 task / lifespan / scheduled job 不走 FastAPIInstrumentor，降级用"时间窗口 + level=error"反查（模板 D）
2. **生产机 curl 返回 Empty reply from server** → 忘了用 `gtcurl`，被 `HTTP_PROXY=127.0.0.1:20171` 劫持
3. **env 为空 / token 未生效** → 忘了 `bash -lc`，login shell 才 source profile.d
4. **Loki 查不到** → retention 30 天超了 / trace_id 不是 32 hex / 日志没注入 trace_id
5. **Jaeger 查不到** → Badger TTL 72h / 采样率不是 100%（不是 `parentbased_always_on`）/ collector 网络断了

## 回报模板

```markdown
## 排查报告 - <一句话症状>

**trace_id**: `<32 hex>` ([Jaeger](http://<HOST>:16686/trace/<id>))
**首次发生**: <ts>
**影响服务**: <go-api / backend / both>

### 现象
- <Span 1 出错: ...>
- <Span 2 retry 失败: ...>

### 根因
<一两句>

### 关键日志
```
[backend/error] 2026-04-22T... knowledge.search 调 Qdrant 超时（30s）
[go-api/info]   2026-04-22T... GET /api/v2/chats 502
```

### 异常 stack（GlitchTip <AGENT-3>）
<前 10 行>

### 建议修复
1. <短期>
2. <长期，挂 PR / issue>
```

## 操作纪律（硬规则）

- ⛔ 不要在本地 export token，**永远** `ssh root@HOST 'bash -lc "..."'` 调用
- ⛔ 不要尝试用当前 token 删 issue / 改 project（scope read-only，会 401）
- ⛔ 不要把 token 字面值写进代码、Wiki、PR、commit message
- ✅ 排查记录要持久化时写 `docs/incidents/YYYY-MM-DD-<name>.md`

## 代码位置（Nine 仓库 `/Users/dajay/AI_Workspace/nine/`）

| 主题 | 位置 |
|---|---|
| Python OTEL init | `server/backend/app/observability/tracing.py` |
| Python 日志 trace_id 注入 | `server/backend/app/observability/logging_config.py::_inject_trace_id` |
| Python Sentry init | `server/backend/app/observability/sentry_init.py` |
| Go OTEL init | `server/api/pkg/observability/tracing.go` |
| Go Gin 中间件（OTEL+Sentry） | `server/api/pkg/observability/middleware.go` |
| Go zap trace_id 注入 | `server/api/pkg/log/log.go::WithContext` |
| otel-collector 配置 | `deploy/observability/otel-collector.yaml` |
| 观测栈 compose | `deploy/observability/docker-compose.dev.yml` |
