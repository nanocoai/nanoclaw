## ADDED Requirements

### Requirement: 替代 runCliQuery 的交互模式接口
系统 SHALL 提供 `runInteractiveQuery()` 函数，接口签名与现有 `runCliQuery()` 语义一致（接收 prompt、回调 ContainerOutput、返回 result），但底层使用 tmux 输入 + SSE 拦截输出。

```typescript
function runInteractiveQuery(
  config: InteractiveCliConfig,
  writeOutput: (output: ContainerOutput) => void,
  log: (message: string) => void,
): Promise<{ newSessionId?: string; result?: string }>
```

#### Scenario: 首条消息
- **WHEN** 收到 session 的第一条消息（无 sessionId）
- **THEN** 创建 tmux session + 启动 Claude CLI，发送消息，通过 SSE tap 接收响应，映射为 ContainerOutput 回调，返回 newSessionId

#### Scenario: 后续消息
- **WHEN** 收到 session 的后续消息（有 sessionId 对应的 tmux session）
- **THEN** 向已有 tmux session 发送消息，等待 SSE tap 收到完整响应

#### Scenario: session 丢失恢复
- **WHEN** 后续消息到达但对应 tmux session 已不存在
- **THEN** 以 `--resume <sessionId>` 重建 tmux session，发送消息，正常响应

### Requirement: SSE 事件映射为 ContainerOutput
系统 SHALL 将 SSE 拦截的结构化事件映射为与现有 cli-runner 一致的 ContainerOutput 格式：
- `tool_use` content block → `{ status: 'progress', progressType: 'tool_use', result: '<emoji> <toolName>: <shortInput>' }`
- `message_stop` + 最终文本 → `{ status: 'success', result: '<text>', newSessionId, usage }`
- 错误/超时 → `{ status: 'error', error: '<message>' }`

#### Scenario: 工具调用进度
- **WHEN** SSE 流中出现 tool_use content block
- **THEN** 立即通过 writeOutput 回调发送 progress 类型的 ContainerOutput，包含工具名和缩略输入

#### Scenario: 最终结果
- **WHEN** SSE 流收到 message_stop 且 stop_reason 为 end_turn
- **THEN** 通过 writeOutput 发送 success 类型的 ContainerOutput，包含完整文本、session ID、usage 统计

#### Scenario: 工具调用后继续（多轮 tool use）
- **WHEN** Claude 使用工具后继续生成下一轮响应（stop_reason 为 tool_use）
- **THEN** 发送 tool_use progress 后等待下一轮 SSE 流（Claude CLI 自动执行工具并继续），直到 end_turn

### Requirement: Usage 统计累积
系统 SHALL 从 SSE 事件流中累积完整的 usage 统计，包含 prompt cache 相关指标。

#### Scenario: 单轮 API 调用
- **WHEN** 一次消息只触发一轮 API 调用（stop_reason=end_turn）
- **THEN** 从 message_start 提取 input_tokens/cache_read_input_tokens/cache_creation_input_tokens，从 message_delta 提取 output_tokens，合并为完整 usage

#### Scenario: 多轮 API 调用（tool_use 循环）
- **WHEN** Claude 使用工具后继续生成（多个 message_start → message_stop 循环）
- **THEN** 累加所有轮次的 usage 统计，最终 ContainerOutput.usage 包含总量

### Requirement: 超时控制
系统 SHALL 对每条消息的响应设置超时限制。

#### Scenario: 正常响应
- **WHEN** Claude CLI 在超时时间内完成响应（收到 message_stop 且 stop_reason=end_turn）
- **THEN** 正常返回结果

#### Scenario: 响应超时
- **WHEN** 发送消息后，超过配置的超时时间（默认 10 分钟）仍未收到最终 end_turn
- **THEN** 返回 timeout 错误，不销毁 tmux session（允许 Claude 继续运行，下次消息可恢复）

### Requirement: 启动参数注入
系统 SHALL 在 tmux 启动 Claude CLI 时注入所有必要的配置参数，与现有 cli-runner 功能对等：
- `--model <model>`: 模型选择
- `--mcp-config <path>`: MCP server 配置文件
- `--dangerously-skip-permissions`: 跳过权限确认
- `--add-dir <dir>`: 额外工作目录
- `--append-system-prompt <text>`: 追加 system prompt
- 环境变量: `HTTPS_PROXY`、`NODE_EXTRA_CA_CERTS`（OneCLI 代理）

#### Scenario: 完整参数注入
- **WHEN** 创建新 tmux session 启动 Claude CLI
- **THEN** 所有配置参数正确传递，Claude CLI 按预期初始化（正确模型、MCP server 可用、代理生效）

#### Scenario: resume 模式启动
- **WHEN** 需要恢复已有 session（tmux session 丢失但 sessionId 存在）
- **THEN** 以 `claude --resume <sessionId>` 加上完整配置参数重启
