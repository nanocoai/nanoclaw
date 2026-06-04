## Why

Anthropic 2026-06-15 起将 Agent SDK 调用独立计费（$20-$200/月 per 账号），与交互式 CLI 订阅配额分离。NanoClaw 当前的 `claude --print` 模式虽已移除 `CLAUDE_AGENT_SDK_CLIENT_APP` header，但 `--print` 本身仍被归类为 Agent SDK 用量。要走订阅配额（无限量），必须使用真正的交互式 CLI 模式。

## What Changes

- **BREAKING**: 废弃现有 `claude --print --output-format stream-json` 的 per-turn spawn 模式
- 新增 tmux 常驻会话管理：每个 agent session 对应一个 tmux session，通过 `tmux send-keys` 注入用户消息
- 新增 OneCLI 代理层 SSE 流拦截：复用现有 OneCLI HTTPS 代理，在代理端拦截 Anthropic API 的 SSE 响应流，解析为结构化输出
- 新增 session 生命周期管理：tmux session 创建、健康检查、异常恢复、优雅退出
- 保留现有 MCP 配置注入机制（`--mcp-config`）、skill/prompt 加载（`--append-system-prompt`）、多目录支持（`--add-dir`）
- 保留现有 per-group 账号隔离（OneCLI HTTPS_PROXY token 替换）

## Capabilities

### New Capabilities
- `tmux-session-manager`: tmux 会话生命周期管理 — 创建、输入注入、健康检查、异常恢复、退出清理
- `sse-stream-interceptor`: OneCLI 代理层 SSE 响应流拦截与解析 — 从 HTTPS 代理中提取 Anthropic API 的 SSE 事件，映射为 ContainerOutput
- `interactive-cli-runner`: 交互模式运行器 — 整合 tmux 输入 + SSE 输出，替代现有 cli-runner.ts 的 runCliQuery 接口

### Modified Capabilities
- （无现有 spec 需修改，cli-runner 为首次 spec 化）

## Impact

- **代码**: `container/agent-runner/src/cli-runner.ts` 重写核心逻辑；`src/container-runner.ts` 调整进程启动方式（tmux 替代 spawn）；OneCLI 代理可能需要新增 SSE tap 端点
- **依赖**: 运行环境需安装 tmux；OneCLI 需支持 SSE 流转发/拦截 API
- **API**: `runCliQuery()` 接口签名变更，输入不再走 stdin JSON，输出不再走 stdout stream-json
- **系统**: 每个活跃 agent session 占用一个 tmux session + 一个 claude 进程（常驻而非 per-turn）
- **账号**: 继续通过 OneCLI HTTPS_PROXY 实现 per-group 账号隔离，无变化
