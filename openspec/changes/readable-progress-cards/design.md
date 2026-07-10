## Context

当前 runner 在工具事件仍为结构化对象时，直接拼接成 `result` 和 `detail`：Claude 路径的 `buildToolUseProgress()` 生成 `🔧 Bash: <command>`，Codex 路径的 `mapCodexProgress()` 生成 `🔧 <command>`。host 的 `mainOnOutput` 再把这两个字符串传给飞书，`FeishuChannel.sendMessage()` 只追加步骤，不知道工具名、调用 ID、参数结构和结果归属。

实测历史卡片说明，自然语言中间叙述通常已经表达“为什么做”，结构化工具事件表达“做什么”，工具结果表达“做得怎样”。当前问题不是缺少一次新的语言模型翻译，而是语义在 runner 边界被过早压平。

GitNexus 影响分析结果为 LOW：`mapCodexProgress` 影响 `handleLine -> runCodexQuery` 两级调用；`buildToolUseProgress` 和飞书 `sendMessage` 未发现高风险上游。尽管单符号风险低，协议字段跨 runner/host/channel，仍需按兼容迁移交付。

## Goals / Non-Goals

**Goals:**

- 所有工具调用都能得到用户可读的展示，包括明确语义和中性 fallback。
- 常见工具准确表达动作、对象和状态；复杂命令不虚构业务含义。
- 真实计划和自然语言阶段可以组织工具动作，结果回填原步骤。
- 默认卡片隐藏技术噪音，过程记录保留调试依据。
- 分类逻辑纯函数化、跨 runner 复用、零额外 LLM 延迟。

**Non-Goals:**

- 不构建完整 shell 解释器，不承诺理解任意脚本的业务目的。
- 不执行命令来判断命令含义，不使用网络服务或模型做展示翻译。
- 不根据已发生动作预测未发生的开发、部署或评审计划。
- 不改变工具授权、执行、审批和沙箱策略。
- 本 change 不重做过程记录页面的信息架构，只保证技术详情继续可访问。

## Decisions

### D1. 扩展协议而不是在飞书层反向解析字符串

为 `ContainerOutput` 增加可选的结构化 progress 元数据，字段包含 provider、toolName、toolCallId、bounded input、lifecycle/status 和可用结果摘要。原 `result/detail/progressType` 保留，兼容旧 runner。

runner 是最后一个可靠持有原始对象的位置：Claude 有 tool block name/id/input，Codex 有 item id/type/command/status，MCP 适配层有 server/tool。若继续只传字符串，`mcp_tool_call` 永远无法恢复真实动作。

替代方案“飞书层解析标题和 Markdown”被拒绝，因为它依赖展示字符串格式，无法可靠关联结果，也会重复当前 parse-back 反模式。

### D2. 新增共享纯函数展示层

新增独立模块，例如 `src/progress-display.ts`，包含：

- provider 归一化后的 `StructuredProgressEvent` 类型；
- `classifyProgressAction(event, phaseContext)`；
- `reduceProgressPresentation(state, event)`；
- 有界标题、详情清洗和 fallback；
- 版本化工具分类表。

Feishu channel 只消费 `ProgressPresentationState`，不在卡片构建代码里维护命令正则。纯函数使 20+ 历史样本无需 mock 即可验证。

替代方案“把规则继续写进 `FeishuChannel.sendMessage`”被拒绝，因为它会把协议、分类、状态和 I/O 再次耦合进大文件。

### D3. 阶段来源使用严格优先级

阶段来源优先级固定为：

1. runner 提供的真实 plan 事件；
2. 紧邻工具调用前、已被判定为中间叙述的文本；
3. 工具分类生成的通用阶段；
4. 中性 fallback。

没有 plan 时，状态机只保存已经出现的阶段和当前阶段，不创建待办阶段。中间叙述先缓冲，只有后续出现 tool_use 才成为阶段锚点，避免把最终回复误当计划。

阶段标题使用原叙述的首个可读句并做长度限制，不再请求模型摘要。若文本是“找到关键点了”等结果陈述，可作为阶段进展而非未来计划。

### D4. Bash 采用高置信分类而非任意理解

分类器先剥离 `bash -lc` / `zsh -lc` / `sh -c` 外壳，再识别有限命令族：

- inspect/search：cat、sed、rg、grep、find、GitNexus context/query；
- change：Write/Edit、apply_patch、明确的文件写入；
- verify：pytest、vitest、go test、npm test、git diff --check、规范校验；
- build：npm run build、go build、docker build；
- observe：Loki、Jaeger、Grafana、日志查询；
- delivery：gh pr、gh run、部署命令、文档上传；
- communicate：lark-cli IM、dispatch/report/review MCP；
- destructive：rm、git push --delete 等明确破坏性动作。

复合命令只有在子动作属于同一类别时聚合。Python heredoc、任意脚本和未知二进制不做深层语义执行；有阶段时显示“在该阶段运行分析脚本”，无阶段时显示“正在运行脚本/系统检查”。

不引入 shell parser 运行时依赖。本 change 只做无执行的有界词法识别和结构化工具映射；复杂 shell 的正确策略是降级，不是追求完整解析。

### D5. 调用与结果由 ID 归并

`ProgressPresentationState` 按 `toolCallId` 保存 action。started 创建或更新进行中动作，completed/result 原地更新状态与用户摘要。Codex 使用 item ID，Claude 使用 tool use ID；缺失 ID 的旧事件只能按顺序展示，不能进行不可靠的跨行猜配。

显式成功才展示“已完成”；非零退出码或 error 展示失败；取消展示已取消；turn 结束仍无结果的动作展示“已执行/结果未知”。这避免流程跑完就被误标为业务成功。

### D6. 默认展示和技术记录分层

默认卡片只渲染：阶段标题、动作标题、状态和安全摘要。原始 command、绝对路径、内部 ID 和长输出不进入卡片。

过程记录继续接收有界 detail。新结构化 input 只在内存中用于分类，默认不写 messages.db；日志只记录 category/confidence/toolName 等元数据，不记录完整参数。已有 detail 的敏感信息风险不在本 change 扩大，后续可独立做过程记录脱敏。

### D7. 渐进迁移和失败回退

交付顺序为：先添加兼容字段和测试，再接入分类器，再切 Feishu 渲染。旧字段始终保留到全部 runner 模式完成迁移。任一分类异常返回 fallback 展示；任一卡片异常走现有最终回复路径。

每个阶段可独立回滚：关闭新展示消费后，旧 `result/detail` 仍能生成原过程卡片。

### D8. 默认卡片以任务阶段为展示单位

`ProgressPresentationState` SHALL 分开保存完整工具流水和最多三个用户可见阶段。工具调用是阶段的证据，不是默认卡片的一行：同一阶段内连续发生的 Read、Grep、Write、Bash、MCP 调用只更新该阶段的 `currentAction`、`object`、`outcome` 和状态。完整工具流水继续进入过程记录。

每个可见阶段至少包含可读目标；能从结构化参数确定对象时必须包含对象；结果事件能确定数量、测试结果、退出码或匹配情况时必须生成有界结果。完成事件只改变状态和结果，不得把“搜索聊天记录”覆盖成“已完成协作操作”这类分类名称。

替代方案“最后三个工具调用直接上卡”被拒绝。真实记录已证明，一个 40 步任务最终只剩“已完成搜索/已完成搜索/已完成协作操作”，虽然技术状态正确，但用户无法判断任务推进情况。

### D9. 信息不足时保留阶段，不制造空标签

阶段上下文不再是一次性消费。真实 plan 的进行中项或最近有效过程说明持续作为当前阶段，直到出现新的阶段说明、plan 状态切换或 turn 结束。通用 Bash 无法解析时显示为当前阶段的保守动作；没有任何阶段时才允许临时显示中性动作。

中性动作不得成为有可用语义信息时的最终展示。最终卡若已有阶段、对象或结果，必须优先展示这些信息并聚合同类动作；不得因为可见窗口截断而退化成连续的分类标签。

## Risks / Trade-offs

- [自然语言阶段过长或像结论] -> 只使用首句、有界截断，并区分“阶段锚点”和“进展说明”；不据此生成未来步骤。
- [命令分类误判] -> 规则只覆盖高置信命令族，输出 confidence；低置信一律继承阶段或 fallback。
- [复合 shell 存在破坏性子命令] -> destructive 规则优先级最高，不允许被“验证/系统检查”聚合掩盖。
- [provider 字段能力不一致] -> 所有新字段可选，按 Claude/Codex/Gemini 实际能力降级，并保留旧协议。
- [参数含敏感信息] -> 分类输入有界、仅内存使用、日志不打印参数、默认卡片不展示原值。
- [进度状态增长] -> 沿用卡片可见窗口和过程记录上限，turn 结束清理 state。
- [结果事件缺失] -> 使用“已执行/结果未知”，不误报成功。
- [阶段上下文错误地延续到下一目标] -> 新 narration、plan 状态切换和明确目标变化必须关闭旧阶段；零 mock reducer 测试覆盖阶段切换。
- [结果摘要提取不稳定] -> 只提取结构化数量、测试通过/失败数、退出码和已知 MCP 结果；无法确定时保留动作结果未知，不编造结论。

## Migration Plan

1. 添加结构化类型、历史 fixture 和兼容协议测试，保持 UI 不变。
2. 分 provider 填充工具名、ID、参数摘要与完成状态。
3. 引入纯函数分类器和 presentation reducer，影子运行并记录分类类别/置信度，不打印参数。
4. 切换飞书过程卡片到新展示；保留配置级快速回退到旧标题。
5. 在 Claude 与 Codex 群分别运行真实飞书 E2E，核对卡片和过程记录。
6. 稳定后移除影子日志；旧协议字段暂不删除。

回滚时关闭新展示消费即可恢复旧卡片，runner 新增可选字段不会影响旧 host 行为。

## Open Questions

- Gemini 当前暴露的工具 item 元数据是否足够提供稳定 call ID，实施时需用 fixture 核实；缺失则按 provider 降级，不阻塞本 change。
- 真实 plan 事件在不同 CLI provider 的可见性不同；仅对确实收到的 plan 提供完整计划展示，不通过 prompt 强迫所有模型生成计划。
- 过程记录的敏感信息全面脱敏是否另立 change，本 change 只保证默认卡片不扩大暴露。

## 测试计划

### 测试分层

- 纯函数零 mock：工具分类、外壳剥离、复合命令聚合、阶段优先级、状态归并、结果回填、fallback、敏感字段不进入标题。
- runner 映射测试：Claude/CLI/Codex/Gemini fixture 到结构化事件，覆盖 started/completed、缺字段和旧协议。
- channel 测试：mock 飞书 create/patch，验证可读卡片、窗口、失败回退和过程记录 detail。
- Real E2E：真实飞书消息触发 Claude 与 Codex，读取最终 interactive 卡内容和过程记录证据。

### 优先级

- P0：结构化 ID、无额外 LLM、阶段级展示、信息价值硬门槛、未知命令 fallback、默认卡片不含原始命令、结果原地回填、失败不误报成功、旧协议兼容。
- P1：阶段继承、复合命令聚合、MCP 名称保留、跨 provider 一致、过程记录保留详情。
- P2：更多工具词典、统计摘要和置信度观测。

### 预估范围

- 纯函数和历史 fixture：约 35-45 个用例。
- runner 协议：约 15-20 个用例。
- 飞书 channel：约 10-15 个用例。
- Real E2E：至少 6 个场景，覆盖阶段聚合、明确命令、复杂脚本、MCP、结果摘要、失败和跨模式；每条都保存真实飞书运行中与终态截图，并执行禁用文案反向断言。
