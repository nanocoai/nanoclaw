## Why

SDK 模式下，agent 把给用户的最终结论写进了「带工具调用的那一轮」（text 块 + 紧跟一个 `TodoWrite` 之类的收尾工具），框架会把这段 text 判成「中间叙述」降级成 `💬` 进度，而不是正式回复。叠加两个放大因素：(1) `quietProgress:true` 的群把 `💬` 埋进进度卡片，用户根本看不到；(2) 若该轮被 `/model` 切换等操作打断，SDK 的 `result` 消息永不到达，缓存的 text 在 `runQuery` 的 `finally` 里被直接清空丢弃（commit `8664d6e` 把循环末尾的「无条件 flush」改成了 `finally` 清理）。最终现象：agent 的结论消息彻底没发出来。非定时任务的 `SendMessage` 工具被禁用，agent 也没有主动补发的退路。

## What Changes

- 引入「收尾型工具白名单」（finalizing tools，如 `TodoWrite`）：当一段缓存 text 后面**只**跟随白名单内的工具（不含任何会继续干活的实质工具如 Read/Bash/Edit/Grep），不再把这段 text 降级成 `💬` 中间叙述，而是当作**正式回复**（`status:'success'`）发出。
- 恢复「中断兜底补发」：`runQuery` 因 abort/异常退出走 `finally` 时，若缓存里仍有判定为「最终回复」的 text，补发为正式回复（而非丢弃），并保留 `8664d6e` 引入的跨会话泄漏防护。
- 正式回复不双发：「升格/补发候选」与「发 result」同轮互斥——result 非空总是发 result 并丢候选，仅 result 为空或被中断时才发候选，结构上避免双发（无需指纹去重）。
- **不改** `SendMessage` 的禁用策略（不在本次扩面，避免引入重复发风险）。

## Capabilities

### New Capabilities
- `agent-output-delivery`: 规定 agent-runner 如何从 SDK 消息流中判定「哪段文本是发给用户的正式回复」、中间叙述如何降级、以及流被中断时的兜底投递规则。

### Modified Capabilities
<!-- 无既有 spec 的 requirement 变更 -->

## Impact

- 代码：`container/agent-runner/src/index.ts`（SDK 路径的 text 块判定、tool_result/result/finally 三处分流）。可能新增一个纯函数（收尾工具判定）便于单测。
- 行为：仅影响「text 后紧跟收尾型工具」与「轮次被中断」两个边界场景；正常的「过场叙述 + 实质工具」与「end_turn 纯文本回复」路径行为不变。
- 配置：`quietProgress` 群是主要受益方（结论不再被埋）。
- 无 API/依赖变更，无 DB schema 变更。
