## 1. 回归样本与协议契约

- [ ] 1.1 从已调研的真实过程卡片整理不少于 20 个脱敏 fixture，覆盖文件、Git、测试、构建、可观测、GitHub、飞书、Web、MCP、复合 Bash、Python heredoc、未知命令和破坏性命令
- [ ] 1.2 为 `ContainerOutput` 新增可选结构化进度字段编写失败测试，覆盖 Claude tool ID、Codex item ID、provider、bounded input、完成状态和旧事件兼容
- [ ] 1.3 在 `container/agent-runner` 与 host 的重复类型定义中加入一致的结构化字段，并确保现有 `result/detail/progressType` 不变
- [ ] 1.4 运行 runner/host 类型检查和协议定向测试，确认新旧事件均可解析

## 2. 各运行模式保留结构化工具语义

- [ ] 2.1 为 Claude SDK/print/interactive 路径编写 started/result 关联测试，并在原始 tool block 处填充 toolName、toolCallId、provider 和有界参数
- [ ] 2.2 为 Codex `item.started/item.completed` 编写同 ID 生命周期测试，并填充 command_execution、file_change 的结构化状态与退出码
- [ ] 2.3 核实 Gemini 实际事件 fixture；有稳定 ID 时填充同类字段，无稳定 ID 时增加明确降级测试
- [ ] 2.4 为 MCP 调用补充 server/tool 名称保留测试，禁止到 host 后只剩 `mcp_tool_call`
- [ ] 2.5 运行所有 runner 映射测试，确认工具执行输出与最终回复行为未改变

## 3. 纯函数语义分类器

- [ ] 3.1 新建 `src/progress-display.ts` 及测试，定义 normalized event、action category、confidence、display action 和 presentation state
- [ ] 3.2 先写 Read/Write/Edit/Grep/Glob/WebSearch、Git、测试、构建、GitHub、飞书、可观测和 MCP 的分类失败测试
- [ ] 3.3 实现高置信工具分类表，使动作、对象和状态与 fixture 预期一致
- [ ] 3.4 先写 shell 外壳、复合验证命令、嵌套 SSH、Python heredoc、未知二进制和破坏性命令的失败测试
- [ ] 3.5 实现有界 shell 识别、同类聚合、destructive 优先和阶段继承 fallback，不引入 shell 执行或额外 LLM
- [ ] 3.6 增加默认标题安全测试，禁止原始命令、绝对路径、chat/trace ID、主机地址进入用户可见标题和正文

## 4. 阶段与结果状态归并

- [ ] 4.1 为真实 plan、工具前中间叙述、通用分类和 fallback 的优先级编写 reducer 测试
- [ ] 4.2 实现阶段状态：真实 plan 可含未来步骤；动态阶段只记录已出现/进行中步骤，不生成预测计划
- [ ] 4.3 为 toolCallId 的 started/completed/error/cancel/unknown 编写原地更新测试
- [ ] 4.4 实现调用结果回填和 turn 结束收口，缺少成功证据时使用“已执行/结果未知”
- [ ] 4.5 增加连续同类动作聚合和可见窗口测试，保证过程记录仍保留完整步骤

## 5. Host 与飞书过程卡片接入

- [ ] 5.1 扩展 `mainOnOutput` 到 channel 的进度传递方式，使飞书能消费结构化事件，同时保留字符串 fallback
- [ ] 5.2 在 `FeishuChannel` 中维护每个 JID 的 presentation state，并用纯 reducer 处理 plan/text/tool started/result 事件
- [ ] 5.3 修改卡片渲染为阶段化用户文案，默认隐藏原始命令、路径和内部 ID
- [ ] 5.4 保持“过程记录”接收有界技术 detail，验证 messages.db 和普通日志不新增完整参数副本
- [ ] 5.5 增加展示分类异常、卡片 create/patch 失败和旧 runner 事件的回退测试，确保最终回复不丢失
- [ ] 5.6 提供配置级旧展示回退开关，并测试开关只影响展示、不影响工具执行

## 6. 完整验证与代码评审

- [ ] 6.1 运行 progress display、runner、container-runner、Feishu channel 定向测试并保存结果
- [ ] 6.2 运行 `npm run build`、`npm test` 和 `git diff --check`，确认无新增失败
- [ ] 6.3 使用 GitNexus detect changes 或人工调用链兜底检查实际影响范围，确认只命中进度协议和展示流程
- [ ] 6.4 发起代码 Review，逐项关闭 P0/P1，并对误判、敏感信息、结果虚绿和跨 provider 行为做专项审查

## 7. Real E2E 与证据复审

- [ ] 7.1 按 `e2e-plan.md` 在 Claude 模式执行明确命令、复杂 Bash、未知脚本和失败命令场景
- [ ] 7.2 在 Codex 模式执行同类测试，验证 command started/completed 使用同一步骤且结果状态正确
- [ ] 7.3 执行 MCP 和真实 plan/动态阶段场景，验证不再出现裸 `mcp_tool_call`，没有 plan 时不编造未来步骤
- [ ] 7.4 读取真实飞书 interactive 卡原文，反向断言默认卡片不含 shell、绝对路径、内部 ID 和重复结果行
- [ ] 7.5 打开对应过程记录，确认有界技术详情仍能支撑排查，并保存消息 ID、卡片摘录、过程记录摘录和运行日志
- [ ] 7.6 将 E2E 证据交评审复核，关闭全部 P0/P1 后再汇报完成

## 8. 信息价值纠偏

- [ ] 8.1 将 presentation state 从工具行模型改为“完整工具流水 + 最多三个可见任务阶段”，并为阶段持续、切换和结束编写零 mock 测试
- [ ] 8.2 为阶段增加目标、当前动作、对象、结果和状态字段；完成事件必须保留已有语义并只更新状态与可靠结果
- [ ] 8.3 实现同一阶段内 Read/Grep/Write/Bash/MCP 的聚合和重复动作折叠，过程记录仍保存全部工具步骤
- [ ] 8.4 增加黄金卡片快照，固定 RPC-01 至 RPC-06 的运行中和终态展示；出现孤立“已完成搜索/协作操作/系统检查”直接失败
- [ ] 8.5 按修订后的 `e2e-plan.md` 重跑真实飞书 E2E，保存完整窗口截图、状态日志和过程记录三方证据

## 9. 语义对象与完成态保真

- [ ] 9.1 从历史卡片补充 Read/Grep/Write/Edit、测试、Git、Web、飞书和 MCP 的对象级黄金样例，禁止仅断言动作分类
- [ ] 9.2 实现 basename、脱敏关键词、目标文件和测试套件的有界对象提取；未知命令继续中性降级
- [ ] 9.3 阶段累积并去重动作对象摘要，完成态保留对象和可靠结果，不回退为“已完成 XX”分类清单
- [ ] 9.4 增加默认卡片泄露反向测试，覆盖绝对路径、内部 ID、地址、凭证和超长 query
- [ ] 9.5 全量测试与 build 通过后统一交 8 号 review；本阶段不部署、不重启
