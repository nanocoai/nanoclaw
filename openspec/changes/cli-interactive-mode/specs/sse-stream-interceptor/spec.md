## ADDED Requirements

### Requirement: OneCLI 代理层 SSE 响应拦截
系统 SHALL 在 OneCLI HTTPS 代理层拦截 Claude CLI 发往 Anthropic API 的请求-响应对，提取 SSE (Server-Sent Events) 响应流中的事件数据。

拦截点为 OneCLI 代理在转发 `api.anthropic.com/v1/messages` 响应时，将 SSE 事件实时转发给 NanoClaw 订阅者。原始 SSE 流 SHALL 不被修改，保证 Claude CLI 正常运行。

#### Scenario: 正常拦截 SSE 流
- **WHEN** Claude CLI 通过 OneCLI 代理向 `api.anthropic.com/v1/messages` 发起 streaming 请求
- **THEN** OneCLI 代理在转发响应的同时，将每个 SSE 事件（`message_start`、`content_block_start`、`content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`）实时推送到 tap 端点

#### Scenario: 非 Anthropic 请求不拦截
- **WHEN** Claude CLI 通过 OneCLI 代理访问非 `api.anthropic.com` 的 URL
- **THEN** 代理正常转发，不触发 SSE 拦截逻辑

#### Scenario: 代理连接中断
- **WHEN** OneCLI 代理与 NanoClaw 的 tap 连接断开
- **THEN** 代理继续正常转发原始 SSE 到 Claude CLI（不影响 Claude 运行），拦截功能降级但不阻塞

### Requirement: SSE 事件解析为结构化数据
系统 SHALL 将 Anthropic SSE 完整事件集解析为结构化的中间表示。

完整事件类型列表：
- `message_start`: 提取 model、message_id、usage（含 input_tokens、cache_read_input_tokens、cache_creation_input_tokens）
- `content_block_start`: 提取 block index、type（text 或 tool_use）、tool_use 时提取 name 和 id
- `content_block_delta`: 提取 text delta（text_delta 类型）或 input JSON delta（input_json_delta 类型）
- `content_block_stop`: 标记指定 index 的 block 完成
- `message_delta`: 提取 stop_reason、output_tokens
- `message_stop`: 标记消息结束
- `ping`: 忽略（心跳）
- `error`: 提取错误信息

解析器 SHALL 维护 `Map<number, BlockAccumulator>` 状态机，按 content block index 关联 start/delta/stop 事件，确保 tool_use 的 name（来自 start）和 input（来自 delta 累积）正确组装。

**核心纯函数**：
- `parseSseLine(raw: string): { event: string; data: string } | null` — 提取 SSE 行的 event 和 data
- `parseSseEvent(eventType: string, data: string): SseEvent | null` — 解析单条事件为结构化类型
- `accumulateSseMessage(accumulator: MessageAccumulator, event: SseEvent): MessageAccumulator` — 无副作用的状态累积

#### Scenario: 解析文本响应
- **WHEN** 收到 `content_block_start(type=text)` 后续多个 `content_block_delta(type=text_delta)` 最后 `content_block_stop`
- **THEN** 累积所有 text delta 为完整文本，block 完成时标记 finalized

#### Scenario: 解析 tool_use 响应
- **WHEN** 收到 `content_block_start(type=tool_use, name="Bash", id="toolu_xxx")` 后续 `content_block_delta(type=input_json_delta)` 最后 `content_block_stop`
- **THEN** 提取 tool name 和 id（来自 start），累积 input JSON delta，block 完成时解析 JSON 为 tool input 对象

#### Scenario: 解析 usage 统计（含 cache 指标）
- **WHEN** 收到 `message_start`（含 `message.usage`）和 `message_delta`（含 `usage`）
- **THEN** 从 `message_start` 提取 input_tokens、cache_read_input_tokens、cache_creation_input_tokens；从 `message_delta` 提取 output_tokens。合并为完整 usage 对象

#### Scenario: 畸形 SSE 数据容错
- **WHEN** 收到无法解析的 SSE 行或 JSON 格式错误
- **THEN** 跳过该行并记录 warning 日志，不中断流解析

#### Scenario: error 事件处理
- **WHEN** 收到 `event: error` 的 SSE 行
- **THEN** 解析错误信息，标记当前消息为失败，不再等待 message_stop

### Requirement: Tap 通信机制
NanoClaw 主进程 SHALL 通过本地通信机制（Unix domain socket / HTTP localhost）订阅 OneCLI 代理的 SSE tap 数据。

每个活跃的 agent session 对应一个 tap 订阅，按 chatJid 或 proxy token 区分。

#### Scenario: 建立 tap 订阅
- **WHEN** interactive-cli-runner 发送消息前
- **THEN** 向 OneCLI tap 端点注册订阅，开始接收该 session 的 SSE 事件

#### Scenario: 接收完整消息
- **WHEN** 收到 `message_stop` 事件
- **THEN** 标记当前消息完成，将累积的结构化数据作为完整响应返回

#### Scenario: 多 session 并发
- **WHEN** 多个 agent session 同时活跃
- **THEN** 按 proxy token / request 来源区分不同 session 的 SSE 事件，不交叉
