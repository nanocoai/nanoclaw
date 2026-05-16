## ADDED Requirements

### Requirement: CLI 模式 spawn 交互式 claude 进程
当 agent-runner 收到 `useCliMode: true` 配置时，SHALL spawn 交互式 `claude` 进程（不带 `-p` 参数），而非调用 Agent SDK 的 `query()` API。

#### Scenario: CLI 模式启动
- **WHEN** agent-runner 启动且 containerInput 包含 `useCliMode: true`
- **THEN** 使用 `child_process.spawn` 启动 `claude` 可执行文件，传入交互模式参数

#### Scenario: SDK 模式不受影响
- **WHEN** agent-runner 启动且 containerInput 不包含 `useCliMode` 或值为 false
- **THEN** 继续使用 `@anthropic-ai/claude-agent-sdk` 的 `query()` API

### Requirement: CLI 模式支持 session resume
CLI 模式 SHALL 通过 `--resume <sessionId>` 参数支持会话恢复，行为与 SDK 模式的 `resume` 选项一致。

#### Scenario: 有 session 时恢复
- **WHEN** CLI 模式启动且存在 sessionId
- **THEN** 传入 `--resume <sessionId>` 参数，claude 进程从上次会话继续

#### Scenario: 无 session 时新建
- **WHEN** CLI 模式启动且无 sessionId
- **THEN** 不传 `--resume` 参数，claude 进程创建新会话

### Requirement: CLI 模式支持 stdin 消息输入
CLI 模式 SHALL 通过 stdin 向 claude 进程发送用户消息，支持多轮对话。

#### Scenario: 首轮消息通过参数传入
- **WHEN** CLI 模式启动
- **THEN** 将 prompt 作为 `--prompt` 参数传入（首轮），后续消息通过 stdin 写入

#### Scenario: IPC 多轮消息通过 stdin
- **WHEN** IPC 目录收到新消息文件
- **THEN** 将消息内容写入 claude 进程的 stdin

### Requirement: CLI 模式解析 stdout 输出
CLI 模式 SHALL 解析 claude 进程的 stdout 输出，提取文本回复、工具调用、usage 信息，转换为与 SDK 模式一致的 ContainerOutput 格式。

#### Scenario: 文本回复提取
- **WHEN** claude 进程输出包含文本回复
- **THEN** 解析并封装为 `{ status: 'success', result: text }` 格式

#### Scenario: 工具调用进度
- **WHEN** claude 进程输出包含工具调用信息
- **THEN** 解析并封装为 `{ status: 'progress', progressType: 'tool_use' }` 格式

### Requirement: CLI 模式支持 MCP server
CLI 模式 SHALL 通过 `--mcp-server` 参数挂载 MCP server，保持 NanoClaw MCP 工具可用。

#### Scenario: MCP server 挂载
- **WHEN** CLI 模式启动
- **THEN** 传入 `--mcp-server nanoclaw node <mcp-server-path>` 及对应环境变量

### Requirement: CLI 模式支持 model override
CLI 模式 SHALL 通过 `--model` 参数或 settings.json 设置模型。

#### Scenario: 启动时指定模型
- **WHEN** CLI 模式启动且有 modelOverride
- **THEN** 传入 `--model <model>` 参数

### Requirement: CLI 模式支持权限绕过
CLI 模式 SHALL 传入 `--dangerously-skip-permissions` 参数，与 SDK 模式的 `permissionMode: 'bypassPermissions'` 等效。

#### Scenario: 权限绕过
- **WHEN** CLI 模式启动
- **THEN** 传入 `--dangerously-skip-permissions` 参数

### Requirement: CLI 模式不带 x-client-app header
CLI 模式 SHALL 确保不设置 `CLAUDE_AGENT_SDK_CLIENT_APP` 环境变量，使请求不带 `x-client-app` header，从而走交互式配额。

#### Scenario: 环境变量清理
- **WHEN** CLI 模式启动
- **THEN** 确保进程环境中不包含 `CLAUDE_AGENT_SDK_CLIENT_APP` 变量
