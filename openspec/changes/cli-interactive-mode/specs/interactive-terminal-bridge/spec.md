## ADDED Requirements

### Requirement: 三层终端桥常驻运行
系统 SHALL 将 interactive mode 拆分为常驻的 Input Bridge、Output Bridge、Health Supervisor 三层循环，而不是用单次 `runInteractiveQuery()` 的 Promise 生命周期代表整个 Claude CLI turn。

#### Scenario: 启动终端桥
- **WHEN** interactive mode runner 启动
- **THEN** 系统创建或复用 tmux session，启动 Tap Proxy 订阅，并进入 input/output/health 三个常驻循环

#### Scenario: 上层协议保持不变
- **WHEN** Output Bridge 产生 progress、success 或 error
- **THEN** 系统 SHALL 继续通过现有 ContainerOutput 写出，主进程和飞书发送链路无需改协议

### Requirement: Input Bridge 持续消费用户输入
系统 SHALL 让 Input Bridge 持续读取 IPC input 队列，并根据 tmux pane 状态决定立即注入、排队或触发恢复。

#### Scenario: prompt ready 时两阶段注入
- **WHEN** IPC input 队列存在新消息且 tmux pane 处于 ready prompt
- **THEN** Input Bridge SHALL 先将该 IPC 文件原子 claim 到 `input/.inflight/<turnId>.json`，再通过 tmux send-keys/load-buffer 将消息注入 Claude CLI，并记录 currentTurnId、currentInputFile、currentInputDigest、lastInputAt、lastActivityAt

#### Scenario: CLI 忙碌时保留队列
- **WHEN** IPC input 队列存在新消息但 tmux pane 显示 Thinking、Booping、工具执行或 active SSE
- **THEN** Input Bridge SHALL 保留该消息，不删除 IPC 文件，不重复注入，并等待 health/output 循环推进状态

#### Scenario: Claude 确认接收后删除 inflight 文件
- **WHEN** tmux 注入消息和 Enter 都成功执行，且 Tap Proxy 观察到该 turn 绑定的首个 `/v1/messages` request，或 pane 明确离开 ready prompt 进入 busy 状态
- **THEN** Input Bridge SHALL 删除对应 `.inflight/<turnId>.json` 文件，避免服务重启后重复执行同一条用户消息

#### Scenario: 注入后未观察到 Claude 接收
- **WHEN** tmux 注入命令成功但超时内没有 `/v1/messages` request，pane 也没有离开 ready prompt
- **THEN** Input Bridge SHALL 保留 `.inflight/<turnId>.json` 并让 Health Supervisor 判定为 degraded，不得静默删除用户消息

### Requirement: Output Bridge 不依赖单一 SSE final
系统 SHALL 优先使用 Tap Proxy SSE 生成结构化输出，但不得把 `message_stop/end_turn` 作为唯一结束信号。

#### Scenario: turn 与 SSE stream 绑定
- **WHEN** Input Bridge 创建 currentTurnId 并注入消息后，Tap Proxy 观察到后续 `/v1/messages` request
- **THEN** Output Bridge SHALL 为该 request 生成 requestId/streamId，并只将该 stream 的 accumulator 绑定到 currentTurnId

#### Scenario: SSE 正常结束
- **WHEN** Output Bridge 收到 message_stop 且 stop_reason 为 end_turn
- **THEN** 系统 SHALL flush pending output，写出 success，并将当前 turn 标记为 idle

#### Scenario: SSE 无 final 但 prompt ready
- **WHEN** tmux pane 已回到 ready prompt，当前 turn 长时间没有新的有效 SSE 事件，且没有可 flush 的 pending output
- **THEN** 系统 SHALL 写出带 degradedReason 的 ContainerOutput，标记 current turn 为 degraded-finished，并释放 Input Bridge 继续处理下一条 IPC 消息

#### Scenario: 只收到中间进度
- **WHEN** 当前 turn 已发送 text/tool progress 但没有最终结果
- **THEN** 系统 SHALL 保留已发送进度，不重复发送，并在 degraded-finished 时写出结构化 warning 日志和带 degradedReason 的 ContainerOutput

#### Scenario: 迟到 SSE 不污染下一轮
- **WHEN** 某个 turn 已被降级收口，随后该 turn 绑定的 stream 才收到 message_stop 或 pending text
- **THEN** Output Bridge SHALL 将该事件记录为 orphan/degraded 日志，不得写 success，不得修改当前 active turn

### Requirement: Health Supervisor 自动判死和恢复
系统 SHALL 用 tmux 存活、pane 状态、Tap Proxy 活动、IPC backlog 四类证据判断 interactive session 是否健康，并自动收口或重建。

#### Scenario: parse failed 回到 prompt
- **WHEN** pane 中出现 `tool call could not be parsed` 且 pane 已处于 ready prompt
- **THEN** Health Supervisor SHALL 写出 error output，结束当前 turn，并允许 Input Bridge 继续消费下一条 IPC

#### Scenario: prompt ready 但 IPC backlog 被阻塞
- **WHEN** `readyStableMs >= 5000`、`sseQuietMs >= 15000`、`activeSseStreams === 0`、`currentTurn.state === 'busy'`、`backlogCount > 0`、且 `pendingOutput == null`
- **THEN** Health Supervisor SHALL 主动收口当前 turn，记录 `prompt-ready-with-backlog` 原因，并让 Input Bridge 注入下一条消息

#### Scenario: 采样失败连续超限
- **WHEN** pane capture 连续失败 3 次，或 Tap Proxy 订阅连续 3 次健康检查失败
- **THEN** Health Supervisor SHALL 标记 session 为 restarting，销毁坏 session，并保留未确认消费的 `.inflight` 输入用于恢复

#### Scenario: Tap Proxy 或 tmux 不健康
- **WHEN** Tap Proxy 端口不可用、tmux session 不存在、或 Claude CLI 进程已退出
- **THEN** Health Supervisor SHALL 标记 session 为 restarting，销毁坏 session，并用 durable Claude session id 重建

### Requirement: 状态持久化
系统 SHALL 为每个 interactive group 持久化最小运行状态，避免主进程重启后只靠内存猜测。

#### Scenario: 状态写入
- **WHEN** session id、tmux session name、currentTurnId、currentInputFile、currentInputDigest、currentRequestIds、finalEmitted、degradedReason、lastActivityAt 或 runner state 发生变化
- **THEN** 系统 SHALL 写入 `data/ipc/<groupFolder>/interactive-state.json`

#### Scenario: 重启恢复
- **WHEN** NanoClaw 主进程重启后重新处理该 group
- **THEN** 系统 SHALL 读取 interactive-state，校验 tmux session 和 Tap Proxy 是否仍有效；无效则重建，有效则继续复用

#### Scenario: inflight 恢复
- **WHEN** 重启时发现 `input/.inflight/<turnId>.json` 且状态显示该 turn 未观察到 requestId 或 finalEmitted=false
- **THEN** 系统 SHALL 根据 currentRequestIds 和 pane 状态决定重放、继续等待或归档为 degraded，不得直接删除该 inflight 文件
