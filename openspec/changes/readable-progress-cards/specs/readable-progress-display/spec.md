## ADDED Requirements

### Requirement: 结构化进度事件保持执行语义

NanoClaw SHALL 在 runner 仍持有原始工具事件时，将可获得的工具名、工具调用 ID、提供方、参数摘要和执行状态作为可选结构化字段传给 host。现有 `result`、`detail` 和 `progressType` SHALL 保持兼容，旧 runner 或缺少结构化字段的事件仍可正常展示。

结构化参数 SHALL 有长度上限，SHALL NOT 把凭证、完整环境变量或新增的敏感内容写入普通日志和消息数据库。结构化字段只服务进度分类和调用结果关联，不改变工具执行参数。

#### Scenario: Claude 工具调用保留语义
- **WHEN** Claude 产生名称为 `Bash`、ID 为 `toolu_123`、参数包含 `rg -n model src/` 的工具调用
- **THEN** host SHALL 同时收到 `toolName=Bash`、`toolCallId=toolu_123` 和有界参数摘要，而不是只收到 `🔧 Bash: rg ...` 字符串

#### Scenario: Codex 命令开始与完成可以关联
- **WHEN** Codex 依次产生同一 item ID 的 `command_execution` started 和 completed 事件
- **THEN** 两个进度事件 SHALL 使用同一个 `toolCallId`，完成事件 SHALL 携带可用的退出状态

#### Scenario: 旧事件向后兼容
- **WHEN** host 收到只包含 `progressType`、`result` 和 `detail` 的旧进度事件
- **THEN** 系统 SHALL 继续渲染过程卡片并走保守分类，SHALL NOT 因缺少新字段中断回复

### Requirement: 展示转换不额外调用模型

系统 SHALL 使用确定性纯函数把结构化工具事件和当前阶段上下文转换为用户可见动作。展示转换 SHALL NOT 发起额外 LLM 请求，SHALL NOT 改写工具参数，SHALL NOT 延长工具执行链路等待模型翻译。

#### Scenario: 高频工具确定性转换
- **WHEN** 收到 Read、Write、Edit、Grep、Glob、WebSearch、测试、构建、Git、GitHub、飞书或已知 MCP 工具事件
- **THEN** 转换结果 SHALL 来自版本化规则和结构化参数，并具有稳定的动作类别、标题和置信等级

#### Scenario: 同一输入稳定输出
- **WHEN** 相同的工具事件和阶段上下文被重复转换
- **THEN** 结果 SHALL 完全一致，不受网络、模型或随机性影响

### Requirement: 真实计划优先且动态阶段不编造未来

系统 SHALL 按以下优先级确定过程卡片结构：真实 plan 事件高于工具调用前的自然语言过程说明，过程说明高于工具分类兜底。真实 plan 可展示待办、进行中和完成状态；没有真实 plan 时，系统 SHALL 只展示已经观察到或正在执行的动态阶段，SHALL NOT 根据命令猜测尚未发生的后续计划。

工具调用前被 runner 判定为中间叙述的文本 SHALL 可作为后续调用的阶段锚点。阶段标题 SHALL 使用该叙述的用户可读首句或有界摘要，不再次调用模型总结。

#### Scenario: 真实计划驱动完整计划
- **WHEN** runner 提供包含待办、进行中和完成状态的真实 plan 事件
- **THEN** 过程卡片 SHALL 按该计划展示步骤，并将后续工具动作归入对应进行中步骤

#### Scenario: 叙述驱动动态阶段
- **WHEN** Agent 先输出“我先核对模型配置为什么没有生效”，随后调用搜索工具
- **THEN** 卡片 SHALL 创建“核对模型配置为什么没有生效”阶段，并把搜索动作归入该阶段

#### Scenario: 没有计划时不预测
- **WHEN** 当前 turn 没有 plan 事件，且只观察到“收集日志”阶段
- **THEN** 卡片 SHALL 展示该已发生阶段，SHALL NOT 自动增加“修改代码”“部署上线”等未发生步骤

### Requirement: 常见工具按动作和对象语义化

系统 SHALL 为高频工具建立有界分类表，至少覆盖：文件读取、文件搜索、文件修改、Git 历史/差异/状态、测试、构建、可观测查询、GitHub PR/CI、飞书消息/文档、Web 搜索、MCP 服务与工具。分类结果 SHALL 区分动作、对象和状态，而不是只把工具名翻译成中文。

#### Scenario: 文件与关键词共同确定对象
- **WHEN** `rg` 搜索 `opus-4.8` 且目标路径包含模型配置代码
- **THEN** 卡片 SHALL 显示类似“正在搜索模型配置的引用位置”，而不是展示完整命令

#### Scenario: 可观测命令识别环境
- **WHEN** 命令通过 `ssh dev` 查询 Loki、Jaeger 或 Grafana
- **THEN** 卡片 SHALL 显示类似“正在查询 DEV 链路日志”，并隐藏连接参数和内部地址

#### Scenario: 破坏性操作不被弱化
- **WHEN** 已识别命令执行删除远程分支、删除文件或其他破坏性动作
- **THEN** 用户可见文案 SHALL 明确表达删除对象，SHALL NOT 降级成含糊的“系统检查”

### Requirement: Bash 和通用 exec 分级识别与保守降级

系统 SHALL 忽略 `/bin/zsh -lc`、`bash -lc`、`sh -c` 等外壳，优先检查内部高置信命令族。复合命令只在动作意图一致或存在明确主动作时合并；任意 Python、脚本、管道或未知二进制不得仅凭命令文本虚构业务目的。

无法从命令确定业务目的时，系统 SHALL 继承最近的有效阶段锚点并显示保守动作；若阶段锚点也不存在，则 SHALL 使用“正在执行系统检查”“正在运行脚本”等中性文案。无论降级到哪一级，默认卡片 SHALL NOT 展示原始命令。

#### Scenario: 外壳内已知命令
- **WHEN** 工具名为 Bash，命令为 `/bin/zsh -lc 'npm run build'`
- **THEN** 卡片 SHALL 显示“正在编译项目”或等价文案

#### Scenario: 复杂脚本继承阶段
- **WHEN** 当前阶段为“汇总五次请求耗时”，随后执行无法可靠解析的 Python heredoc
- **THEN** 卡片 SHALL 显示该阶段下的“正在运行分析脚本”或等价保守动作，SHALL NOT猜测脚本内部结论

#### Scenario: 无上下文未知命令
- **WHEN** 命令为未收录的 `./foo --bar` 且没有阶段锚点
- **THEN** 卡片 SHALL 显示中性的系统操作文案，SHALL NOT 暴露完整命令或捏造业务对象

#### Scenario: 多种验证命令合并
- **WHEN** 一个复合命令依次运行 `git diff --check`、规范断言和测试，且各子命令均属于验证类别
- **THEN** 卡片 MAY 合并为单个“正在验证代码和约束”动作，SHALL NOT 展示三条近义步骤

### Requirement: 工具结果回填原步骤

系统 SHALL 使用 `toolCallId` 将工具结果更新到原调用步骤。结果到达后，步骤 SHALL 从“正在”变为“已完成”“失败”“已取消”或“已执行但结果未知”，而不是追加一条重复的结果行。没有明确成功信号时，系统 SHALL NOT 宣称成功。

#### Scenario: 成功结果原地更新
- **WHEN** `toolu_123` 的搜索调用后收到同 ID 的成功结果并返回 12 个匹配项
- **THEN** 原步骤 SHALL 更新为类似“已找到 12 个相关位置”，卡片 SHALL NOT 新增“结果：Grep 结果”行

#### Scenario: 失败结果如实展示
- **WHEN** 命令完成事件包含非零退出码
- **THEN** 对应步骤 SHALL 标记失败并保留可读错误摘要，SHALL NOT 标记完成

#### Scenario: 缺少完成事件
- **WHEN** turn 结束时某工具调用没有可关联的完成事件
- **THEN** 系统 SHALL 使用“已执行”或“结果未知”状态，SHALL NOT推断成功

### Requirement: 默认卡片与技术详情分层

飞书过程卡片 SHALL 默认只展示用户可读的阶段、动作、对象和状态。原始 shell、绝对路径、内部消息 ID、trace ID、主机地址和长输出 SHALL NOT 出现在默认卡片标题或正文。现有“过程记录”页面 SHALL 保留有界技术详情，供调试和审计使用，但 SHALL 继续遵守现有敏感信息处理约束。

#### Scenario: 默认卡片隐藏技术细节
- **WHEN** 工具参数包含绝对路径、chat ID、trace ID 和完整 curl 命令
- **THEN** 默认卡片 SHALL 只显示语义化动作，SHALL NOT 显示这些原始值

#### Scenario: 过程记录保留调试依据
- **WHEN** 用户打开同一 turn 的“过程记录”
- **THEN** 页面 SHALL 继续提供有界技术详情，使开发者能够定位实际执行内容

### Requirement: 跨运行模式一致且可回退

Claude SDK、print/interactive、Codex 以及能提供工具事件的其他运行模式 SHALL 使用同一展示分类和状态归并语义。提供方缺少某些字段时 SHALL 按可用信息降级，SHALL NOT 为追求展示一致性阻断主回复。

#### Scenario: Claude 与 Codex 同类命令一致
- **WHEN** Claude Bash 和 Codex command_execution 都执行项目测试
- **THEN** 两种模式 SHALL 产生等价的“正在运行测试”展示类别

#### Scenario: 展示层异常不阻断回复
- **WHEN** 语义分类或卡片 patch 抛出异常
- **THEN** 系统 SHALL 记录告警并回退到现有安全展示或最终回复路径，SHALL NOT丢失最终答案

### Requirement: 历史样本成为回归契约

实现 SHALL 包含一组脱敏的真实历史样本，覆盖明确工具、复合 Bash、嵌套 SSH、Python heredoc、MCP、Web、失败结果、缺少结果和破坏性命令。样本 SHALL 同时断言可读性、保守性和默认卡片不泄露原命令。

#### Scenario: 真实样本回归
- **WHEN** 对脱敏历史样本运行展示分类测试
- **THEN** 每个样本 SHALL 命中预期动作类别或明确 fallback，且未知样本 SHALL NOT 被断言为虚构的业务动作
