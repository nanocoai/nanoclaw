# 可读过程卡片 Real E2E 计划

## 目标

验证真实飞书链路中的过程卡片做到：用户看得懂、未知命令不乱猜、结果原地更新、默认卡片不泄露技术细节、过程记录仍可调试。配置和单测存在不算 E2E 通过，必须读取真实 interactive 消息内容。

## 环境与证据

- Claude 模式测试群和 Codex 模式测试群各一个，记录 chat ID、触发消息 ID、过程卡 message ID 和 session/process URL。
- 每个场景使用唯一 marker，按 marker 对齐消息、runner 日志和过程记录。
- 原始证据保存卡片文本、过程记录步骤和结构化 runner 事件摘录；不得只写口头结论。

## 用例

### RPC-01 明确命令语义

- 触发一个需要读取文件、搜索文本、修改临时测试文件并运行测试的安全任务。
- 卡片 SHALL 展示读取、搜索、修改、测试等用户动作。
- 卡片 SHALL NOT 出现 `zsh -lc`、完整命令和绝对路径。
- 过程记录 SHALL 保留有界技术详情。

### RPC-02 复合 Bash 聚合

- 触发 `git diff --check`、规范断言和测试组成的复合验证命令。
- 卡片 SHALL 聚合为验证类动作，SHALL NOT 按 shell 分隔符拆出多条噪音。
- 任一子命令失败时，步骤 SHALL 显示失败而不是完成。

### RPC-03 复杂 Python 继承阶段

- Agent 先产生“汇总多次请求耗时”的中间叙述，再运行无法可靠静态理解的 Python heredoc。
- 卡片 SHALL 将脚本归入该阶段并使用保守动作。
- 卡片 SHALL NOT 声称脚本已经定位根因或预测后续修复。

### RPC-04 无上下文未知命令

- 通过测试 fixture/受控工具产生未知命令事件，且不提供 plan 或阶段锚点。
- 卡片 SHALL 使用“运行脚本/系统检查”类 fallback。
- 卡片 SHALL NOT 展示命令正文或虚构业务对象。

### RPC-05 MCP 名称和结果关联

- 触发一次聊天搜索或评审派发 MCP 调用。
- 卡片 SHALL 展示真实业务动作，SHALL NOT 出现裸 `mcp_tool_call`。
- MCP 结果 SHALL 更新原步骤，不新增重复结果行。

### RPC-06 真实计划与动态阶段边界

- 一轮提供真实 plan，验证待办/进行中/完成状态按 plan 展示。
- 另一轮不提供 plan，只产生过程叙述和工具调用。
- 无 plan 的一轮 SHALL 只展示已发生和进行中的阶段，SHALL NOT 生成未来待办。

### RPC-07 Claude/Codex 一致性

- 在 Claude 和 Codex 分别执行等价的读取与测试任务。
- 两种模式 SHALL 使用相同动作类别和用户语义。
- Codex `item.completed` SHALL 原地更新 `item.started` 创建的步骤。

### RPC-08 失败、取消和结果缺失

- 分别触发非零退出码、取消和缺少 completion fixture。
- 卡片 SHALL 显示失败、已取消、已执行/结果未知，SHALL NOT统一标记成功。
- 最终回复 SHALL 正常送达。

## 通过门槛

- 8 个场景全部通过；任何“只看配置/单测但未读取真实卡片”的结果不计通过。
- 默认卡片原始命令泄露数为 0，裸 `mcp_tool_call` 为 0，重复结果行为 0。
- 未知命令误报具体业务目的为 0。
- Claude 和 Codex 核心动作语义一致。
- 过程记录仍有足够技术详情，且普通日志不新增完整工具参数。
