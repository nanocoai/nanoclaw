## ADDED Requirements

### Requirement: 创建 tmux 会话并启动 Claude CLI
系统 SHALL 为每个 agent session 创建独立的 tmux session，在其中启动 `claude` 交互式命令（不带 `--print`），并注入 MCP 配置、model、system prompt、additional directories 等启动参数。

tmux session 命名规则：`nanoclaw-<chatJid 前 8 位>-<时间戳>`，确保全局唯一。

启动时 SHALL 清除 `CLAUDE_AGENT_SDK_CLIENT_APP` 和 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 环境变量，并设置 OneCLI HTTPS_PROXY 环境变量实现账号隔离。

**核心纯函数**：
- `buildTmuxSessionName(chatJid: string): string` — 生成 session 名
- `buildInteractiveCliArgs(config): string[]` — 构建不含 `--print` 的 CLI 参数

#### Scenario: 首次启动新会话
- **WHEN** 收到新 agent session 的首条消息且无现有 tmux session
- **THEN** 创建 tmux session，启动 `claude --mcp-config <path> --model <model> --dangerously-skip-permissions --add-dir <dirs> --append-system-prompt <prompt>` 进程，消息直接注入（不等待就绪信号，30s 超时由 Tap Proxy 层判定），返回 tmux session name

#### Scenario: 恢复已有会话
- **WHEN** 收到消息且已有对应 chatJid 的 tmux session 正在运行
- **THEN** 直接复用已有 tmux session，不重复创建

#### Scenario: session 丢失但 sessionId 存在
- **WHEN** tmux session 不存在但有 sessionId 记录
- **THEN** 创建新 tmux session，启动 `claude --resume <sessionId>` 加完整配置参数

#### Scenario: resume 启动失败
- **WHEN** `claude --resume <sessionId>` 启动后 30 秒内 Tap Proxy 未收到 API 请求
- **THEN** 销毁该 tmux session，以不带 `--resume` 的方式重新创建（新 session），日志记录 resume 失败

#### Scenario: 启动超时
- **WHEN** 首条消息注入后 30 秒内 Tap Proxy 未收到任何 SSE 事件
- **THEN** 销毁该 tmux session，返回错误 `CLI startup timeout`

### Requirement: 通过 tmux 注入用户消息
系统 SHALL 将用户消息文本注入到 Claude CLI 的 stdin。

对于短消息（≤2KB），使用 `tmux send-keys -t <session> -l` 按字面量发送。
对于长消息（>2KB），使用 `tmux load-buffer` + `tmux paste-buffer` 方案，避免 send-keys 缓冲区限制。

**核心纯函数**：
- `escapeTmuxInput(text: string): string` — 转义特殊字符
- `buildTmuxCommand(action: string, sessionName: string, args?: string[]): string[]` — 构建 tmux 命令参数

#### Scenario: 发送短消息（≤2KB）
- **WHEN** 用户消息长度 ≤2KB
- **THEN** 执行 `tmux send-keys -t <session> -l '<escaped_text>'` + `tmux send-keys -t <session> Enter`

#### Scenario: 发送长消息（>2KB）
- **WHEN** 用户消息超过 2KB
- **THEN** 写入临时文件 → `tmux load-buffer <tmpfile>` → `tmux paste-buffer -t <session>` → `tmux send-keys -t <session> Enter` → 删除临时文件

#### Scenario: 发送含特殊字符的消息
- **WHEN** 用户消息包含 `$HOME`、`\n`、单引号等特殊字符
- **THEN** 所有特殊字符被正确转义，Claude CLI 收到原始文本而非展开/解释后的值

#### Scenario: 发送消息到不存在的 session
- **WHEN** 目标 tmux session 已退出或不存在
- **THEN** 返回错误并触发 session 重建流程

### Requirement: 会话健康检查
系统 SHALL 提供健康检查机制，验证 tmux session、claude 进程、以及 MCP server 进程的存活状态。

#### Scenario: 正常运行
- **WHEN** 健康检查执行
- **THEN** 确认 tmux session 存在、claude 进程 PID 存活、MCP server 进程存活（`pgrep -f ipc-mcp-stdio`），返回 healthy

#### Scenario: claude 进程崩溃
- **WHEN** 检测到 tmux session 存在但 claude 进程已退出
- **THEN** 销毁该 tmux session，标记为 unhealthy，下次消息触发重建

#### Scenario: MCP server 进程崩溃
- **WHEN** 检测到 claude 进程存活但 MCP server 进程不存在
- **THEN** 记录 warning 日志。MCP server 由 Claude CLI 自动管理，不主动重启；如果后续消息因 MCP 不可用而报错，由 Claude CLI 自行处理

### Requirement: 优雅退出与清理
系统 SHALL 在 agent session 结束时优雅退出 Claude CLI 并销毁 tmux session。

#### Scenario: 正常退出
- **WHEN** agent session 标记为结束（超时/用户关闭）
- **THEN** 向 tmux session 发送 `/exit` 命令，等待 claude 进程退出（最长 10 秒），然后 `tmux kill-session`

#### Scenario: 强制退出
- **WHEN** 优雅退出超时（claude 进程 10 秒内未退出）
- **THEN** 直接 `tmux kill-session -t <session>` 强制终止

#### Scenario: 进程残留清理
- **WHEN** NanoClaw 主进程启动时
- **THEN** 扫描所有 `nanoclaw-*` 前缀的 tmux session，销毁孤儿 session
