## Why

NanoClaw 的飞书过程卡片目前直接展示 `/bin/zsh -lc`、完整 Bash、`mcp_tool_call` 等执行细节，普通用户看不出系统正在完成什么目标。近期抽查 19 张过程卡片并扩大检查到约 250 条消息后确认：常见动作可以稳定语义化，但通用 Bash、Python 脚本和信息丢失后的 MCP 调用不能靠命令文本可靠猜测，必须采用结构化事件、阶段上下文和保守降级共同解决。

## What Changes

- 为 runner 到 host 的进度事件补充向后兼容的结构化工具元数据，保留工具名、调用 ID、参数摘要、执行提供方和结果状态。
- 新增确定性的进度展示层，将工具调用转换为“阶段、动作、对象、状态”，不额外调用 LLM。
- 优先使用真实 plan 事件；没有正式计划时，仅用工具调用前的自然语言过程说明形成已发生/进行中的动态阶段，不编造未来步骤。
- 为 Read/Write/Edit、搜索、Git、测试、构建、可观测、GitHub、飞书、Web 和 MCP 等常见工具提供高置信语义映射。
- 对 Bash/exec/脚本采用分级识别：识别明确子命令，继承当前阶段；仍不明确时统一降级为可读但不虚构的系统操作文案。
- 过程卡片默认不展示原始命令、绝对路径、内部 ID 和原始输出；这些信息继续保留在“过程记录”技术详情中。
- 工具结果按 `toolCallId` 回填同一步骤，避免调用与结果重复占两行，并如实显示失败、取消和未知终态。
- 建立来自真实历史卡片的脱敏回归样本，并设计 Claude SDK、Codex 与真实飞书链路 E2E。

## Capabilities

### New Capabilities

- `readable-progress-display`: 定义结构化进度事件、阶段化展示、工具语义分类、结果回填、保守降级与技术详情分层。

### Modified Capabilities

无。

## Impact

- Agent runner：`container/agent-runner/src/index.ts`、`cli-runner.ts`、`interactive-cli-runner.ts`、`sse-parser.ts`、`codex-runner.ts`，以及可提供同类元数据的 Gemini 路径。
- Host 协议与路由：`src/container-runner.ts`、`src/index.ts`、`src/types.ts`。
- 展示与状态：新增纯逻辑语义格式化/状态归并模块，修改 `src/channels/feishu.ts` 只消费展示结果，不在卡片组件内解析 shell。
- 测试：runner 映射、纯函数分类/归并、飞书卡片、跨模式回归和真实飞书 E2E。
- 不新增运行时依赖，不改变工具执行行为，不删除现有 `result/detail` 字段。
