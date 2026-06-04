## Why

Anthropic 2026-06-15 起将 Agent SDK 调用独立计费（$20-$200/月 per 账号），与交互式 CLI 订阅配额分离。NanoClaw 当前的 `claude --print` 模式虽已移除 `CLAUDE_AGENT_SDK_CLIENT_APP` header，但 `--print` 本身仍被归类为 Agent SDK 用量。要走订阅配额（无限量），必须使用真正的交互式 CLI 模式。

## What Changes

- **BREAKING**: 废弃现有 `claude --print --output-format stream-json` 的 per-turn spawn 模式
- 新增 tmux 常驻会话管理：每个 agent session 对应一个 tmux session，通过 `tmux send-keys` 注入用户消息
- 新增 OneCLI 代理层 SSE 流拦截：复用现有 OneCLI HTTPS 代理，在代理端拦截 Anthropic API 的 SSE 响应流，解析为结构化输出
- 新增三层终端桥目标态：Input Bridge 只负责消息进入 tmux，Output Bridge 持续同步 SSE/pane 输出，Health Supervisor 负责 prompt/进程/代理判死和恢复
- 分阶段调整 interactive runner 生命周期：第一刀用 watchdog 降级收口释放被阻塞的 `runInteractiveQuery()`；目标态再取消“单轮 resolve 后才读取下一条 IPC”的前置条件
- 新增 session 生命周期管理：tmux session 创建、健康检查、异常恢复、优雅退出
- 保留现有 MCP 配置注入机制（`--mcp-config`）、skill/prompt 加载（`--append-system-prompt`）、多目录支持（`--add-dir`）
- 保留现有 per-group 账号隔离（OneCLI HTTPS_PROXY token 替换）

## Capabilities

### New Capabilities
- `tmux-session-manager`: tmux 会话生命周期管理 — 创建、输入注入、健康检查、异常恢复、退出清理
- `sse-stream-interceptor`: OneCLI 代理层 SSE 响应流拦截与解析 — 从 HTTPS 代理中提取 Anthropic API 的 SSE 事件，映射为 ContainerOutput
- `interactive-cli-runner`: 交互模式运行器 — 整合 tmux 输入 + SSE 输出，替代现有 cli-runner.ts 的 runCliQuery 接口
- `interactive-terminal-bridge`: 三层终端桥 — 将输入、输出、健康监督拆成常驻循环，保证后续消息不被上一轮 SSE 收尾失败卡死

### Modified Capabilities
- （无现有 spec 需修改，cli-runner 为首次 spec 化）

## Impact

- **代码**: `container/agent-runner/src/interactive-cli-runner.ts` 先增加 prompt-ready-with-backlog 降级收口，后续从 per-turn query 改为 per-group daemon；`tmux-session-manager.ts` 增强 prompt/pane 判定；`agent-runner/index.ts` interactive 分支后续改为启动常驻终端桥；`src/group-queue.ts` 的 IPC 写入语义保持不变
- **依赖**: 运行环境需安装 tmux；OneCLI 需支持 SSE 流转发/拦截 API
- **API**: 上层 ContainerOutput 协议不变；第一阶段仍保留 `runInteractiveQuery()` 外观，但降级收口后不得补发空 success；目标态 interactive 内部不再暴露“每轮 query 完成后才读下一条 IPC”的语义
- **系统**: 每个活跃 agent session 占用一个 tmux session + 一个 claude 进程（常驻而非 per-turn）
- **账号**: 继续通过 OneCLI HTTPS_PROXY 实现 per-group 账号隔离，无变化
