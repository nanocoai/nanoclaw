## ADDED Requirements

### Requirement: 请求发起前创建仅标题卡
系统 SHALL 在飞书有效 Agent 请求进入模型调用前创建一张交互卡片，卡片此时只显示动态处理标题和计时，不显示等待文案、分隔线、过程记录链接、Phase 或工具行。建卡失败 MUST NOT 阻断模型调用。

#### Scenario: 普通请求立即获得起手卡
- **WHEN** 普通主循环开始处理一轮有效飞书 Agent 请求并 await `setTyping(true)`
- **THEN** 系统在继续模型调用前完成起手卡创建尝试
- **AND** 创建成功的卡片只包含处理标题与计时

#### Scenario: 起手卡创建失败
- **WHEN** 飞书创建起手卡失败或未返回 message_id
- **THEN** 系统清理占位状态并继续模型调用
- **AND** 后续正式回复仍通过现有发送路径送达

### Requirement: 直接文本首响应原卡转正
若起手卡之后尚未出现 narration、plan、工具调用或其他可见进度，首个有效最终输出为不含图片/文件发送标记的文本或 Markdown，系统 SHALL 停止 spinner，并把同一 message_id 的起手卡原地替换为最终回复正文。系统 MUST NOT 为该正文再创建第二条文本或卡片消息。

#### Scenario: 快速纯文本回复
- **WHEN** 起手卡创建成功且首个有效输出直接是最终文本
- **THEN** 系统 patch 同一 message_id 为无处理标题的最终回复卡片
- **AND** `sendMessage` 返回该 message_id
- **AND** 飞书 create 调用总数保持为一次
- **AND** 精确调用次数为 create=1、final patch=1、delete=0

#### Scenario: Codex 文字先以 progress 到达
- **WHEN** Codex interactive 先发送一段或多段 `💬` 文字、整轮没有 plan 或工具活动且 turn success 正文为空
- **THEN** 系统在 turn end 将累积文字作为最终正文 patch 到同一 message_id
- **AND** 不发送 usage-only 卡或第二份正文

#### Scenario: Codex text-only 候选超过上限
- **WHEN** 累积的 text-only 候选正文超过 UTF-8 100KB
- **THEN** 系统停止无界累积并在原卡正文附“全文见过程记录”提示
- **AND** 完整 narration 仍保留在现有过程记录中
- **AND** main 与 retry 的 `tryFinalizeTextOnly` 均使用同一截断候选

#### Scenario: 文字后继续调用工具
- **WHEN** `💬` 文字后出现 plan 或工具事件
- **THEN** 卡片永久进入 progress 状态并沿用现有 Phase/工具规则
- **AND** turn end 不得把此前文字候选原卡转正

#### Scenario: 非 quiet narration 已独立发送
- **WHEN** narration 已按现有 non-quiet 规则独立发送
- **THEN** turn end 不得再把同一 narration 原卡转正
- **AND** usage-only 与过程卡 cleanup 保持现有语义

#### Scenario: 纯文本回复携带 usage
- **WHEN** 直接文本首响应到达前已收到 usage 与 thinking 信息
- **THEN** 原地转正后的卡片包含正文和现有 usage footer
- **AND** usage 与 thinking 状态被消费且不会在后续消息重复出现

#### Scenario: 原卡转正触发语音通知
- **WHEN** 直接文本原卡转正成功且本次回复未设置 skipVoiceNotify
- **THEN** 系统按现有群语音配置触发一次 fire-and-forget 语音通知
- **AND** 语音通知失败不影响卡片终态

#### Scenario: 原卡转正失败
- **WHEN** 最终回复 patch 起手卡失败
- **THEN** 系统删除或终止陈旧起手卡
- **AND** 通过现有正式回复路径发送正文且只发送一次

### Requirement: 首个进度事件接管起手卡
若首个有效输出是 narration、plan 或工具事件，系统 SHALL 将现有起手卡切换为进度态并沿用现有 Phase reducer、工具动作、最多三阶段窗口、过程记录、每秒计时和完成卡规则。系统 MUST NOT 因接管而创建第二张过程卡。

#### Scenario: narration 接管
- **WHEN** 起手卡之后首先到达模型 narration
- **THEN** 系统在原卡上显示现有可展开 Phase 与动作格式
- **AND** 后续 narration 与工具事件遵循既有窗口和冻结规则

#### Scenario: 工具调用接管
- **WHEN** 起手卡之后首先到达工具 started 事件
- **THEN** 系统在原卡上显示既有无 Phase 动作行或当前 Phase 动作
- **AND** 工具结果继续按 toolCallId 回填现有展示状态

#### Scenario: thinking-only 重试后直接回复
- **WHEN** 第一轮仅产生 thinking 且触发重试，第二轮在同一请求内直接产生正文
- **THEN** 起手卡保持可转正状态并复用原 message_id
- **AND** 不创建第二张起手卡或 usage-only 卡

#### Scenario: 接管后正式回复
- **WHEN** 起手卡已被任一可见进度接管后到达最终回复
- **THEN** 系统按既有规则完成过程卡并另行发送正式回复
- **AND** 不启用直接文本原卡转正分支

### Requirement: 媒体与特殊输出保持现有能力
包含图片或文件发送标记的最终回复 SHALL 保持现有媒体提取、上传、失败降级和文本发送语义。系统 MUST NOT 为追求单卡转正而把媒体标记当作普通 Markdown 写入起手卡。

#### Scenario: 首响应包含媒体标记
- **WHEN** 起手卡之后首个最终输出包含图片或文件发送标记
- **THEN** 系统终止或删除仅标题起手卡并走现有媒体发送链路
- **AND** 文本和媒体均按现有规则发送

### Requirement: 终态与并发确定性
起手卡创建、spinner patch、进度接管、正式回复和 cleanup SHALL 共享现有串行 patch 与 finalized 终态约束。终态确定后，任何迟到的 spinner 或进度事件 MUST NOT 覆盖最终回复、创建新过程卡或留下孤儿卡。

#### Scenario: spinner patch 与直接回复并发
- **WHEN** 一个 spinner patch 在途时直接文本首响应到达
- **THEN** 系统先阻止新的进度 patch并排空在途 patch
- **AND** 最终回复 patch 是该 message_id 的最后一次更新

#### Scenario: 建卡与正式回复并发
- **WHEN** 异步入口导致正式回复早于起手卡创建完成
- **THEN** 系统不得同时留下起手卡和独立回复
- **AND** 无法安全原卡转正时确定性降级为现有正式回复路径

#### Scenario: 迟到进度
- **WHEN** 直接文本原卡转正完成后又到达进度事件
- **THEN** 系统忽略该事件并记录终态拒绝日志

#### Scenario: 无正式回复结束
- **WHEN** 请求结束、取消或报错且仅标题起手卡仍存在
- **THEN** cleanup 删除该卡及空过程记录
- **AND** spinner 与内存状态全部清理

### Requirement: 生命周期可观测
系统 SHALL 为起手卡创建、进度接管、直接转正、失败降级和终态拒绝记录结构化日志。日志 MUST 包含 jid、messageId（如有）、阶段、耗时与降级原因，且 MUST NOT 记录完整用户正文、媒体路径、工具参数或凭据。

#### Scenario: 正常直接转正日志
- **WHEN** 起手卡成功原地转为最终回复
- **THEN** 日志能够关联 create 与 finalize 的同一 jid/messageId
- **AND** 明确记录 `start-only -> direct-final` 转移与耗时

#### Scenario: 降级日志
- **WHEN** 建卡或最终 patch 失败
- **THEN** 日志记录失败发生在哪个阶段及 fallback 原因
- **AND** 不记录最终回复正文
