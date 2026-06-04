## Context

NanoClaw 当前 CLI 模式使用 `claude --print --output-format stream-json` per-turn spawn。虽然已移除 `CLAUDE_AGENT_SDK_CLIENT_APP` header，`--print` 本身仍被 Anthropic 归类为 Agent SDK 用量（$200/月上限）。

要走订阅配额（Max Plan 无限量），必须使用真正的交互式 CLI 模式 —— 不带 `--print`，Claude 渲染 TUI 终端界面。

**核心挑战**：交互模式没有结构化输出（stdout 是 TUI 渲染），需要从别的层面获取结构化响应。

**现有基础设施**：
- OneCLI HTTPS 代理（localhost:10254）：MITM 代理，拦截请求注入 API key
- per-group 账号隔离：通过替换 HTTPS_PROXY URL 中的 access token 实现
- MCP 配置注入：`--mcp-config` 临时文件
- session 管理：Claude Code 内置 `--resume` 机制

## Goals / Non-Goals

**Goals:**
- 使 Claude CLI 走订阅配额而非 Agent SDK 配额
- 保持现有 ContainerOutput 接口不变（对上层透明）
- 保持 per-group 账号隔离、MCP 注入、session 恢复等现有能力
- 实时获取工具调用进度（不是等最终结果）

**Non-Goals:**
- 不改 OneCLI 代码（当前 SDK 无 tap API，我们自己解决）
- 不支持 `--print` fallback（一旦切换，彻底弃用旧模式）
- 不做多账号热切换（启动时确定账号，运行期间不换）
- 不实现文件/图片多媒体输入（后续迭代）

## Decisions

### D1: 输出层 — Tap Proxy（中间 MITM 代理）

**选择**：在 Claude CLI 和 OneCLI 之间插入一层 NanoClaw 自建的 MITM 代理（Tap Proxy），拦截 SSE 响应流。

```
Claude CLI ──HTTPS_PROXY──▶ Tap Proxy (localhost:PORT)
                               │  ① TLS 终止（自签 CA）
                               │  ② 读取明文 HTTP
                               │  ③ 拦截 SSE 响应事件
                               ▼
                           ──HTTPS_PROXY──▶ OneCLI (localhost:10254)
                                              │ 注入 API key
                                              ▼
                                          api.anthropic.com
```

**数据流**：
1. Claude CLI 发 CONNECT api.anthropic.com:443 → Tap Proxy
2. Tap Proxy 用自签 CA 生成 api.anthropic.com 证书，与 Claude CLI 建 TLS
3. Tap Proxy 收到明文 POST /v1/messages，转发给 OneCLI（OneCLI 作为上游代理）
4. 响应 SSE 流经 Tap Proxy 时，逐行解析 SSE 事件并推送给 NanoClaw
5. 同时将原始 SSE 透传回 Claude CLI

**替代方案对比**：

| 方案 | 优点 | 缺点 | 判定 |
|------|------|------|------|
| Tap Proxy（中间 MITM） | 自主可控、不改 OneCLI、实时流 | 双重 MITM、CA 管理 | ✅ 选用 |
| 修改 OneCLI 加 tap API | 最干净、单 MITM | 改外部代码、版本耦合 | ❌ 不可控 |
| tmux capture-pane | 零代理 | ANSI 解析地狱、无结构化、延迟 | ❌ 不可靠 |
| Claude session JSONL 监听 | 简单 | 格式私有、可能变更、非实时 | ❌ 脆弱 |

### D2: 输入层 — tmux send-keys

**选择**：每个 agent session 对应一个 tmux session，通过 `tmux send-keys` 注入消息。

Claude CLI 启动命令（在 tmux 中执行）：
```bash
claude --model <model> \
  --mcp-config <path> \
  --dangerously-skip-permissions \
  --add-dir <dirs> \
  --append-system-prompt <prompt>
```

**不带 `--print`**，进入真正的交互模式。

**消息注入**：
```bash
tmux send-keys -t <session> -l '<escaped_message>'
tmux send-keys -t <session> Enter
```

`-l` 参数按字面量发送（literal），避免 tmux 解释特殊键序列。

### D3: 会话生命周期

```
┌─────────────────────────────────────────────────────┐
│                  Session Lifecycle                     │
│                                                       │
│  首条消息 ──▶ createTmuxSession()                     │
│               ├─ 生成 tmux session name                │
│               ├─ 启动 claude（不带 --print）            │
│               ├─ 等待 CLI 就绪（检测提示符）            │
│               └─ 返回 session handle                   │
│                                                       │
│  后续消息 ──▶ sendMessage()                           │
│               ├─ tmux send-keys 注入消息               │
│               ├─ Tap Proxy 拦截 SSE 响应               │
│               ├─ 映射为 ContainerOutput 回调            │
│               └─ message_stop 后返回结果               │
│                                                       │
│  session 结束 ──▶ destroySession()                    │
│               ├─ 发送 /exit 到 tmux                    │
│               ├─ 等待 claude 退出（10s 超时）           │
│               └─ tmux kill-session 清理                │
│                                                       │
│  NanoClaw 启动 ──▶ cleanupOrphanSessions()            │
│               └─ 扫描并销毁 nanoclaw-* 孤儿 session     │
└─────────────────────────────────────────────────────┘
```

### D4: Tap Proxy 架构细节

**CA 证书管理**：
- 启动时生成自签 CA（存在 `data/tap-proxy-ca.pem` + `data/tap-proxy-ca-key.pem`）
- 运行时按需为 `api.anthropic.com` 生成服务器证书（缓存复用）
- Claude CLI 通过 `NODE_EXTRA_CA_CERTS` 信任此 CA
- Tap Proxy 自身通过 OneCLI 的 CA 证书信任 OneCLI

**SSE 事件路由**：
- 每个 CONNECT 请求携带 proxy auth token（从 HTTPS_PROXY URL 中提取）
- Tap Proxy 用 token 作为 session 标识，将 SSE 事件路由到对应的 InteractiveCliRunner 实例
- 通过 EventEmitter / callback 模式推送（进程内通信，无需 IPC）

**SSE 解析状态机**：
```
IDLE ──(POST /v1/messages)──▶ STREAMING
STREAMING ──(message_start)──▶ 提取 model/usage
STREAMING ──(content_block_start type=tool_use)──▶ 发送 tool_use progress
STREAMING ──(content_block_delta type=text_delta)──▶ 累积文本
STREAMING ──(message_delta)──▶ 提取 stop_reason/output_tokens
STREAMING ──(message_stop)──▶ 发送完整结果 ──▶ IDLE
```

### D5: 环境变量链与证书合并

Claude CLI 需同时信任 Tap Proxy CA（用于 CLI ↔ Tap Proxy 的 TLS）。`NODE_EXTRA_CA_CERTS` 只接受单文件，因此将 Tap Proxy CA 与 OneCLI CA 合并到 combined PEM 文件中（复用现有 `ONECLI_COMBINED_CA_PATH` 模式）。

```
Claude CLI 环境:
  HTTPS_PROXY = http://x:<group_token>@localhost:<TAP_PORT>   ← 指向 Tap Proxy
  NODE_EXTRA_CA_CERTS = data/tap-combined-ca.pem              ← Tap Proxy CA + OneCLI CA 合并
  CLAUDE_CONFIG_DIR = <group_sessions_dir>                    ← session 隔离

Tap Proxy 自身:
  UPSTREAM_PROXY = http://x:<group_token>@localhost:10254      ← 指向 OneCLI
  信任 OneCLI CA（通过 tls.createSecureContext 显式加载）
```

**启动时 TLS 健康检查**：Tap Proxy 启动后，向上游发一个 HEAD 请求验证 Tap Proxy → OneCLI → Anthropic 三跳 TLS 握手正常。

### D6: 就绪检测

Claude CLI 交互模式启动后会渲染 TUI。需要检测 CLI 何时"就绪"（可接收消息）。

**方案**：Tap Proxy 层面检测。Claude CLI 启动时不会立即发 API 请求。当第一条用户消息通过 tmux 注入后，CLI 发出 POST /v1/messages 请求，Tap Proxy 收到请求即确认 CLI 在运行。

**简化策略**：不单独检测就绪状态。首条消息直接注入，如果 CLI 还没启动完，tmux send-keys 会排队。当 CLI 就绪后自动处理排队的输入。设置 30 秒超时：如果 30 秒内 Tap Proxy 没收到任何 API 请求，判定启动失败。

### D7: session 恢复（--resume）

tmux session 丢失（崩溃/重启）但 sessionId 还在时，需要恢复：

1. 创建新 tmux session
2. 启动 `claude --resume <sessionId> --mcp-config ... --dangerously-skip-permissions ...`
3. Claude CLI 恢复上下文后进入交互模式
4. 后续消息正常注入

**注意**：`--resume` 在交互模式下也有效，Claude Code 会加载历史 session 数据。

## Risks / Trade-offs

| 风险 | 严重度 | 缓解措施 |
|------|--------|---------|
| `--resume` 在无 `--print` 的交互模式下行为未验证 | P0 | 实现前必须手动验证 |
| Tap Proxy 双重 MITM 增加延迟 | P1 | 本地 loopback，延迟 <1ms，可忽略 |
| tmux send-keys 特殊字符转义不完整 | P1 | 构建完整的转义函数，覆盖测试 |
| Claude CLI TUI 可能输出影响 tmux session 状态 | P2 | TUI 在 tmux 中正常运行，无影响 |
| Anthropic 未来可能通过其他方式识别非人类使用 | P2 | 架构最大程度模拟真人使用模式 |
| 多 tmux session 并发资源占用 | P1 | 设上限（如 10 个并发），超限排队 |
| Tap Proxy 自签 CA 安全性 | P2 | 仅 localhost 通信，CA 私钥权限 600 |

## Migration Plan

### Phase 1: 基础验证（不上线）
1. 手动验证 `claude --resume` 在交互模式下是否有效
2. 手动验证 tmux send-keys 能否正确注入消息并触发 Claude 响应
3. 搭建最小 Tap Proxy，验证 SSE 拦截可行性

### Phase 2: 核心实现
1. 实现 `tap-proxy.ts` — MITM 代理 + SSE 解析
2. 实现 `tmux-session-manager.ts` — 会话生命周期
3. 实现 `interactive-cli-runner.ts` — 整合输入输出
4. 单元测试（纯函数）

### Phase 3: 集成测试
1. 替换 container-runner.ts 中的 CLI 模式调用
2. 端到端测试：发消息 → tmux 注入 → Claude 响应 → SSE 拦截 → ContainerOutput
3. 多 session 并发测试

### Phase 4: 切换上线
1. 配置开关：`USE_INTERACTIVE_CLI=true`
2. 灰度切换：先单群测试，逐步扩大
3. 监控：SSE tap 成功率、响应延迟、tmux session 存活率

**回滚**：关闭 `USE_INTERACTIVE_CLI` 即回退到 `--print` 模式，零代码改动。

### D8: 账号轮换与 Tap Proxy 协同

现有 per-turn spawn 模式下，账号轮换通过下一次 spawn 时注入新 HTTPS_PROXY URL 实现。交互模式下 Claude CLI 常驻，HTTPS_PROXY 启动时固化。

**方案**：Tap Proxy 支持运行时更新上游 proxy token。当 `rotateAccount()` 成功后，通过 Tap Proxy 的 admin 接口更新 `UPSTREAM_PROXY` URL 中的 access token。后续请求自动使用新 token，无需重启 tmux session。

```typescript
// Tap Proxy 内部
tapProxy.updateUpstreamToken(sessionId: string, newToken: string): void
```

## Open Questions

1. **`--resume` 交互模式验证**：需手动测试 `claude --resume <id>` 不带 `--print` 是否能正确恢复会话并进入交互模式
2. **tmux 中 Claude TUI 的键盘事件**：Claude CLI 交互模式是否会拦截某些键序列（如 Ctrl+C），影响 tmux send-keys？
3. **并发 session 上限**：Max Plan 是否有并发会话数限制？多个 tmux session 同时活跃是否触发限流？
4. **OneCLI proxy auth token 在 CONNECT 中的传递方式**：Tap Proxy 转发 CONNECT 到 OneCLI 时，token 以 Proxy-Authorization header 传递还是 URL auth？需验证 OneCLI 的认证机制
5. **CA 证书链**：Tap Proxy CA 是否需要包含在 combined CA 中（给 git 等非 Claude 的 HTTPS 请求用）

## 测试计划

### 测试分层

**P0 — 纯函数单测（零 mock，必测）**：
- `escapeTmuxInput(text)`: 各种特殊字符转义（换行、引号、`$`、反斜杠、Unicode）
- `parseSseEvent(line)`: SSE 行解析 → 结构化事件
- `parseSseLine(raw)`: `data: {...}` 格式提取
- `mapSseToContainerOutput(events)`: SSE 事件序列 → ContainerOutput 映射
- `buildTmuxSessionName(chatJid)`: session 命名规则
- `buildInteractiveCliArgs(config)`: CLI 参数构建（不含 `--print`）
- 预估：**25-30 个用例**

**P1 — mock 外部依赖（重要路径）**：
- TapProxy CONNECT 处理：mock net.Socket，验证 TLS 握手 + 上游转发
- TapProxy SSE 拦截：mock HTTP response stream，验证事件路由
- TmuxSessionManager 生命周期：mock child_process.exec（tmux 命令），验证创建/销毁/健康检查
- InteractiveCliRunner 端到端流：mock tmux + tap proxy，验证消息发送 → SSE 接收 → ContainerOutput 回调
- 预估：**15-20 个用例**

**P2 — 集成测试（锦上添花）**：
- 真实 tmux session 创建/销毁（CI 环境需 tmux）
- 真实 Tap Proxy 启动 + CONNECT 隧道建立
- 预估：**5-8 个用例**

### 优先级总结
- P0: 25-30 用例（纯函数，跑得快，零 flaky）
- P1: 15-20 用例（mock 外部调用）
- P2: 5-8 用例（需 tmux 环境）
- **总计约 50 个测试用例**
