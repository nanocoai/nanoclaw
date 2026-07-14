## Context

当前主循环在 `src/index.ts` 中先 `await channel.setTyping(chatJid, true)`，再发起 Agent 请求；飞书 `setTyping(true)` 只添加 reaction。`src/channels/feishu.ts` 要等第一条 narration、plan 或工具 started 才创建进度卡。正式回复到达时，`sendMessage` 先调用 `cleanupProgressCard`，再通过 `extractAndSendMedia -> sendPlainOrCard` 创建新消息。

现有卡片基础已经具备本改造需要的并发能力：`progressCards` 保存每群单卡状态，`schedulePatch` 合并并串行发送 patch，`finalized` 阻止终态后的更新，cleanup 会等待在途 patch 排空。Phase reducer、工具结果归并、过程记录与卡片字节预算均已稳定，本 change 不重做这些逻辑。

GitNexus 共享索引比当前 `main` 落后 2 个提交，仅作辅助：`createProgressCard` 的已知直接调用方集中在 `FeishuChannel.sendMessage`，风险显示 LOW；当前源码 diff 证明这 2 个提交未修改 `src/`，最终影响判断仍以当前 worktree 的 `rg`、调用点和定向测试为准。

## Goals / Non-Goals

**Goals:**

- 用户发送有效请求后，在模型首包之前立即看到仅标题卡。
- 快速纯文本回复复用同一 message_id 原地转正，不产生重复消息。
- 首个 Phase 或工具事件无缝接管起手卡，之后行为完全沿用现有实现。
- 建卡、计时、接管、终态和迟到事件在并发下只有一个确定结果。
- 保留 usage、语音通知、媒体发送、重试和过程记录能力。

**Non-Goals:**

- 不移植 Nine 的 tool_call/tool_result 独立事件行。
- 不改变 Phase reducer、三阶段窗口、工具文案、退出码语义或展开内容。
- 不改变 Agent runner 事件协议，不新增“任务开始”provider 事件。
- 不把图片或文件嵌入起手卡；媒体继续使用飞书媒体 API。
- 不改变命令回复、授权卡等非 Agent 请求消息。

## Decisions

### D1. 以主循环 `setTyping(true)` 作为 provider 无关的可靠起手卡边界

正常消息循环已经在模型调用前 await `setTyping(true)`，飞书实现可在这里创建起手卡，不需要为 Claude、Codex、Gemini 分别增加 start 事件。建卡失败必须内部吸收并清理状态，不能阻断 Agent。

`report` 注入（`src/index.ts:143`）和 IPC pipe（`src/index.ts:2269`）使用 fire-and-forget 调用，不保证起手卡在后续输出前创建完成；这两条路径明确由 D7 的创建竞态规则兜底。只有普通主循环路径承诺“模型调用前完成建卡尝试”。

替代方案“等待 runner 的 turn.started”被拒绝：provider 事件不一致，且消息还需跨 runner/host 才能到飞书，无法保证首请求前出现。

### D2. 在卡片 entry 上保存三态生命周期

`progressCards` entry 增加显式 `contentState`：`start-only | text-only | progress`。

- 起手卡创建成功后为 `start-only`；
- 只有 narration 文本、尚无 plan 或工具活动时为 `text-only`，卡片仍按现有 Phase 形式展示，同时累积完整文字候选；
- 首个 plan 或工具事件到达后永久转为 `progress`，后续不回退。

正式正文到达时，`start-only` 可直接原卡转正；Codex interactive 在 turn end 时最终正文可能为空，因此 `text-only` 也可在整轮成功结束后用累积文字原卡转正。`progress` 永远走现有“完成过程卡 + 独立正式回复”路径。

不使用 `steps.length === 0` 或“首包类型”作为判断，因为 Codex 会先把纯文本作为 `💬 progress` 发送，而真正的 turn success 可能没有正文；是否原卡转正必须由整轮是否发生 plan/工具活动决定。显式状态更适合日志和竞态断言。

### D3. 空步骤进度卡即为仅标题卡

`buildProgressCard([])` 改为只输出动态标题元素，不输出“正在等待响应”、分隔线或过程记录链接。现有创建路径总是带 initialStep，因此该变化只服务新增起手态。spinner 每秒继续通过 `schedulePatch` 更新标题，起手态不改变卡片结构。

起手卡使用独立 create 路径，不调用当前会执行 `upsertSession` 的 `createProgressCard`，因此不创建空过程记录。进入 `text-only` 或 `progress` 后再按现有路径创建 session 并显示过程记录链接。直接转正或无回复 cleanup 不产生空 session。

### D4. 正式正文与 Codex text-only 共用专门终态方法

新增单一职责方法（命名以实现为准）处理 `start-only/text-only -> direct-final`：

1. 读取但不提前删除 usage/thinking；
2. 设置 `progressDone`、停止 spinner、设置 `finalized` 并从 Map 移除 entry；
3. 等待 `patchLoopPromise` 排空；
4. patch 同一 message_id 为现有结果卡正文样式，并附 usage footer；
5. 清理空 session、presentation、usage 与 thinking；
6. patch 成功后按现有 `skipVoiceNotify`、群配置和上下文规则 fire-and-forget 调用 `notifyVoice`；
7. 返回原 message_id。

最终正文卡不保留“处理中/已完成”标题，符合“更新掉头，直接显示内容”。结果卡 JSON 构建从 `sendPlainOrCard` 抽成可复用纯函数，create 与 patch 使用同一正文结构，避免两个格式分叉。

若终态 patch 失败，删除陈旧起手卡后把正式回复或累积的 text-only 候选作为正文传入现有发送路径；任何分支最多产生一份正文。不得调用会再次完成或删除同一 entry 的通用 cleanup。

Channel 能力固定为 `tryFinalizeTextOnly(jid: string): Promise<boolean>`：返回 true 表示已消费正文、usage/thinking 并完成终态，调用方必须跳过 `sendUsageOnly + cleanupProgressCard`；返回 false 才执行现有收尾。`src/index.ts` 的 main onOutput 与 retry onOutput 两套 turn-end 路径都必须在各自 `sendUsageOnly` 前对称调用，不能只改主路径。若 narration 已按 non-quiet 模式独立发送，则 entry 记录 `narrationSeparatelySent`，不得再次用同一文字转正造成双发，继续走现有 usage-only 与 cleanup 语义。

text-only 候选正文按 UTF-8 100KB 封顶，完整 narration 仍逐条进入现有过程记录；超过上限时，原卡正文使用有界候选并附“全文见过程记录”，避免无界内存增长。最终卡仍服从现有 30KB 卡片预算。

### D5. Phase/工具接管只改变卡来源，不改变展示状态机

现有 narration 分支将 `start-only` 幂等切到 `text-only`，保存全文候选并继续现有 Phase 渲染；plan 或工具分支将 `start-only/text-only` 永久切到 `progress`。两类接管均移除 typing reaction、记录 transition，然后继续原有 `visiblePresentationSteps`、allSteps、session 和 `schedulePatch` 逻辑。因为 entry 已有 messageId，不再进入 create 分支。

后续正式回复看到 `progress`，继续执行当前“完成过程卡 + 独立正式回复”路径；`text-only` 只有在整轮未发生 plan/工具活动且未独立发送 narration 时才转正。这样用户要求的第三条不引入 Phase 语义回归。

### D6. 媒体首响应明确降级到现有链路

图片/文件标记需要上传并发送独立飞书媒体消息，不能安全地只靠 patch 交互卡完成。检测到媒体标记时，不走直接转正：终止并删除仅标题卡，随后原样调用 `extractAndSendMedia`。该路径预期为 1 次起手卡 create、1 次 delete，再由现有媒体/文本链路 create；这是保持现有媒体能力与失败隔离。

### D7. 创建竞态允许安全降级，不允许重复或孤儿

正常路径 await `setTyping(true)`，理论上 Agent 输出不会早于建卡。IPC 注入等 fire-and-forget 入口仍可能制造竞态。占位 entry 继续缓冲状态；若正式回复发现 messageId 为空，不等待不受控网络请求，先 finalized 并移除占位，走现有发送路径。迟到的 create 根据 Map 身份检查删除自己刚创建的孤儿卡。

这是确定性降级，优先保证“只发一份内容”。替代方案“正式回复无限等待 createPromise”会把飞书建卡延迟传递到用户结果，不采用。

### D8. 结构化日志围绕状态转移而不是正文

新增统一日志字段：`jid`、`messageId`、`fromState`、`toState`、`elapsedMs`、`fallbackReason`、`hasUsage`、`hasMedia`。关键日志包含起手卡创建尝试/成功/失败、首次进度接管、直接转正成功/失败、迟到 patch 拒绝。正文只记录长度，不记录内容；媒体路径和工具参数不进入新增日志。

## Risks / Trade-offs

- [短回复从纯文本变成交互卡] → 这是 Nine 同款原卡转正体验的必然结果；正文样式复用现有结果卡，保持字号和 usage footer。
- [setTyping 被非普通入口重复调用] → `ensureStartCard` 必须幂等；已有未终态 entry 时不得创建第二张卡。
- [首个进度与 spinner 同时 patch] → 全部继续走 `schedulePatch`，不新增直接进度 patch。
- [终态 patch 被旧 spinner 覆盖] → 先 finalized、排空 patch loop，最终正文 patch 最后发送。
- [patch 最终正文失败] → 删除起手卡并走现有 create/纯文本 fallback，保证正文可达。
- [媒体无法原卡承载] → 明确走现有媒体链路，不显示原始媒体标记。
- [非 quiet narration 同时独立发送] → 保持当前产品语义；记录 `narrationSeparatelySent`，turn end 不再次原卡转正同一文字。

## Migration Plan

1. 先增加纯函数正文卡构建与三态 lifecycle 类型，不改变调用路径。
2. 接入 setTyping 起手卡和首进度接管，跑飞书定向测试。
3. 接入直接文本原卡转正、媒体降级和终态竞态，补齐日志。
4. 运行 `src/channels/feishu.test.ts`、TypeScript build 与 lint 的改动文件检查；不跑无关全量测试。
5. 真机验证快速文本、首 Phase、首工具、媒体四条路径，读取 interactive message JSON 和日志确认 message_id/patch 次序。

回滚时移除 setTyping 的起手卡创建与 direct-final 分支即可；Phase 和工具状态机未变，无数据迁移。

## Open Questions

无。媒体首响应走现有链路、非 quiet narration 继续双显，均按现有产品语义处理。

## 测试计划

### 测试分层

- 纯函数零 mock：仅标题卡 JSON、最终正文卡 JSON、usage footer、媒体标记判定。
- Channel 单测：mock 飞书 create/patch/delete，验证 setTyping、进度接管、直接转正、失败降级、cleanup 与日志分支。
- 时序测试：可控 Promise 制造 spinner patch、建卡和最终回复竞态，断言最后一次 patch、消息数量和 Map 清理。
- 真机 E2E：真实飞书请求并读取 interactive message JSON、message_id 和本地结构化日志。

### 优先级

- P0：请求前仅标题卡；SDK 正式正文与 Codex text-only 均同 message_id 转正且无第二次 create；Phase/工具复用原卡；终态最后写；建卡/patch 失败仍有且只有一份回复。
- P1：usage footer、语音通知、媒体路径、迟到进度、无回复 cleanup、重复 setTyping、thinking-only retry、重试新一轮、non-quiet 防双发。
- P2：日志字段完整性、reaction 移除时机、卡片正文格式快照。

### 预估范围

- `src/channels/feishu.test.ts` 新增或调整约 14-18 个用例。
- 如需锁定主循环调用顺序，`src/index.test.ts` 增加 1-2 个定向用例；若 Channel 契约已充分覆盖则不改。
- 真机 E2E 4 个场景：快速纯文本、首 Phase、首工具、媒体首响应。
