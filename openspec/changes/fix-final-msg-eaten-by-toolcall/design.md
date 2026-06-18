## Context

SDK 模式下，agent-runner（`container/agent-runner/src/index.ts`）从 SDK 的消息流里逐块读取 assistant 的 text 块，靠一个启发式判定「这段 text 是发给用户的正式回复，还是过场叙述」：

- 收到 text 块时，若 `strip` 后长度 > 5，就缓存进 `pendingThought`，并挂一个 30s 兜底定时器。
- 当**下一条 user / tool_result 消息**到达，说明这段 text 后面跟了工具调用——判定为「中间叙述」，调用 `flushPendingThought()` 发成 `💬`（`progressType:'text'`）进度。
- 当 SDK `result` 消息到达：若 `result.result` 非空，丢弃 `pendingThought`（result 才是正式回复）；若为空，把 `pendingThought` flush 成 `💬`。
- `finally` 清理路径（abort / 异常 / SDK 退出）：`clearTimeout + pendingThought = null`，**直接丢弃**。

这套启发式有个致命假设：「text 后面跟了工具 = 这段 text 不是结论」。但 agent 经常把最终结论写进「结论文本 + 紧跟一个 `TodoWrite` 收尾」的同一轮里。`TodoWrite` 是纯记账工具、对用户和外部系统都无副作用，可结论却因为「后面跟了工具」被降级成 `💬`。

叠加两个放大因素（详见 proposal）：
1. `quietProgress:true` 的群把 `💬` 折叠进进度卡片（截断 80 字、当一个 step），用户根本看不到独立结论消息。
2. 若该轮被 `/model` 切换等操作打断，SDK `result` 永不到达，缓存 text 在 `finally` 被丢弃（commit `8664d6e` 把循环末尾的「无条件 flush」改成了 `finally` 清空，本意是修跨会话泄漏——30s 定时器在下一轮 query 里误触发）。

宿主端分流（`src/index.ts` mainOnOutput）：`status:'progress'` → `channel.sendMessage(..., {isProgress:true})` 进进度卡片；`status:'success'` 且 `result.result` 非空 → 走 `channel.sendMessage(chatJid, text)`（无 isProgress）独立正式回复。**所以「让结论发出来」的机制就是把它判成 `status:'success'`。**

约束：
- 非定时任务的 `SendMessage` 工具被禁用（`mcp-tool-policy.ts`），agent 没有主动补发结论的退路——只能靠 runner 自己判定。
- 不能引入「正常过场叙述被误升格成正式回复」的回归（会刷屏）。
- 不能重新引入 `8664d6e` 修掉的跨会话泄漏。

## Goals / Non-Goals

**Goals:**
- text 后**只**跟收尾型工具（白名单，初始只含 `TodoWrite`）时，把这段 text 当正式回复（`status:'success'`）发出，而非降级 `💬`。
- 恢复中断兜底：`finally` 里若仍有判定为「最终回复」的缓存 text，补发为正式回复而非丢弃，同时保留跨会话泄漏防护。
- 升格 / 补发后，对随后真正到达的、与已发文本重复的 `result` 去重，不双发。
- 把「收尾工具判定」抽成纯函数，便于单测，且让现有 SDK 路径文本判定回归不破。

**Non-Goals:**
- 不改 `SendMessage` 的禁用策略（不在本次扩面，避免引入重复发风险）。
- 不动 CLI 交互模式 / print 模式（`sse-parser.ts` / `cli-runner.ts`）的判定逻辑——本 bug 只在 SDK 路径。
- 不改 `quietProgress` 对 `💬` 的折叠行为（中间叙述在安静模式下仍折叠进卡片，这是有意设计）。
- 不扩充白名单到 `TodoWrite` 之外（如未来要加，靠纯函数 + 单测增量验证）。

## Decisions

### 决策 1：用「收尾型工具白名单」而非「stopReason 判定」

判定一段 text 是否该升格，有两条路：(a) 看这段 text 之后跟随的工具是否全在白名单内；(b) 等到 `result` 消息看 `stopReason`。

选 (a)。理由：本 bug 的核心场景是 result **永不到达**（被打断）或 result 到达时 text 已被错误 flush。等 `stopReason` 解决不了「打断」场景，且 SDK 的 stopReason 不区分「结论轮」与「过场轮」。白名单方案在 tool_result 到达的那一刻就能本地判定，不依赖 result。

白名单初始只放 `TodoWrite`——它是纯记账、对用户和外部系统零副作用的工具。`Read/Bash/Edit/Grep/Glob` 等都表明 agent「还在干活」，文本是过场叙述，不升格。

**判定收敛规则**：缓存一段 text 后，跟随的工具调用可能有多个。只要出现**任何一个**白名单外的实质工具，立即把这段 text 判回「中间叙述」降级 `💬`（对应 spec 场景三：TodoWrite 后又来 Read，仍降级）。只有「text 后跟随的工具**全部**落在白名单内」才升格。

**替代方案**：把 `TodoWrite` 也当实质工具但在 result 阶段补救。否决——result 不到达就没救，正是本 bug。

### 决策 2：工具名要在 assistant 消息处采集，flush 处才判得了

这是落地的硬骨头，必须点明。现状里工具名只出现在 **assistant 消息**的 `tool_use` 块（`index.ts:1166`），而触发 flush 的是**下一条 user/tool_result 消息**（`index.ts:1239`）——那里现在是**无条件** `clearTimeout + flushPendingThought()`，根本拿不到「刚才跑的是什么工具」。所以判定「只跟收尾工具」不是改一处，而是要跨两条消息攒状态：

1. 在 `1166` 处（遍历 assistant content 的 `tool_use` 块时）把本轮缓存 text 之后出现的工具名累积进一个轮级数组（如 `followupToolsSinceText`）。每次新缓存一段 text（`1222` 处）时清空它。
2. 在 `1239` 处不再无条件 flush，而是 `clearTimeout` 后用 `isFinalizingOnly(followupToolsSinceText)` 判定：全是收尾工具 → 把 `pendingThought` 标记为「候选最终回复」（保留缓存、**不发**、不再挂 timer）；否则维持现状 flush 成 `💬`。

「标记候选不立即发」的好处是还能回退：若标记候选后又来一个实质工具，下一条 tool_result 会带着含实质工具的 `followupToolsSinceText` 把它降级回 `💬`（spec 场景三）。

候选真正发出的时机只有两个，且二者互斥：

- 轮正常走到 `result`（`index.ts:1316` 附近）：result.result 非空 → **总是发 result 本身、丢弃候选**（result 是更完整的最终输出，见决策 3）；result.result 为空（正常输出被收尾工具「吃掉」）→ 把候选 text 当 `status:'success'` 正式回复发出。无论哪种，发完都清空 `pendingThought`。
- 轮被打断走 `finally`（result 永不到达）：候选 text 补发为 `status:'success'`（决策 4）。

**替代方案**：tool_result 到达即升格发出。否决——无法处理「TodoWrite 后又跟实质工具」的回退，会误发。

### 决策 3：不需要专门去重——「发候选」与「发 result」天然互斥

评审一度担心 result 是候选 text 的超集时双发。实际上发候选只发生在两种情形：result 为空、或 result 永不到达（finally）。只要 result 非空就**总是发 result、不发候选**——所以「升格发候选」和「发 result」在同一轮里互斥，不存在同一结论双发。

由此**取消**原设计里的 `emittedFinalText` 指纹去重作为核心机制。唯一残留的理论竞态是 30s timer 与 result/finally 抢跑，但 timer 触发 flush 的是 `💬` progress 且会清空 `pendingThought`，flush 后候选已不在，同样互斥。故仅在实现层保留「发出后即置空 `pendingThought`」这一条不变量即可，无需额外指纹比对。

### 决策 4：finally 补发只需 clearTimeout，无需会话标识

核实源码：`pendingThought` 是 `runQuery` 的**函数局部变量**（`index.ts:879` 的 `let`），每轮对话是一次独立的 `runQuery` 调用，变量天然不跨轮共享。`1221` 行注释说的「防跨会话泄漏」，真正防的是那个 **30s 异步 timer**——它的闭包持有 `flushPendingThought`（间接调模块级 `writeOutput`），若在 `runQuery` 返回后才触发，就会把上一轮的 text 写进当前输出流。`8664d6e` 用 `finally` 里 `clearTimeout` 掐掉这个 timer 来修它。

`finally` 本身是**同步**执行、在 `runQuery` return 之前跑完，不存在「串到下一轮」的风险。所以本次恢复补发很简单：`finally` 里先 `clearTimeout`（沿用 `8664d6e`），再判断 `pendingThought` 是否为「候选最终回复」——是则同步补发为 `status:'success'`，否则维持清空。**不需要**绑定会话标识位，那是对不存在问题的过度设计。

### 决策 5：抽纯函数 `isFinalizingOnly(toolNames: string[]): boolean`

把「跟随的工具是否全部落在收尾白名单内」抽成无副作用纯函数，独立单测。`index.ts` 只负责把「这段 text 后跟随了哪些工具名」喂给它。白名单常量集中一处定义，便于未来增量扩充 + 回归。

## Risks / Trade-offs

- [误升格过场叙述导致刷屏] → 白名单只含 `TodoWrite`，且要求「跟随工具全部在白名单内」才升格；任何实质工具出现即回退 `💬`。单测覆盖「TodoWrite 后跟 Read 仍降级」。
- [候选与 result 双发] → 设计上互斥：result 非空总是发 result 丢候选，发候选只在 result 空/不来时（决策 3），不存在双发，无需指纹去重。
- [跨消息攒工具名漏清空] → 每次新缓存 text 时必须清空 `followupToolsSinceText`（决策 2 第 1 步），否则上一段 text 的工具会污染本段判定。单测 + 集成测试覆盖。
- [finally 补发重新引入 timer 泄漏] → `finally` 补发前先 `clearTimeout`（沿用 `8664d6e`），同步补发不跨轮（决策 4）。
- [多段 text + 多工具的复杂交织] → 本次只处理「最后一段缓存 text + 其后跟随工具」的单段场景，与现状 `pendingThought` 单槽缓存语义一致，不扩展为多段队列，降低复杂度。
- [白名单未来膨胀] → 通过纯函数 + 常量集中 + 单测增量约束，本次不预先扩充。

## Migration Plan

- 纯代码改动，无 DB schema、无 API、无依赖变更。
- 部署：随 agent-runner 编译产物（`container/agent-runner/dist/`）发布；所有群共享同一产物。
- 回滚：改动集中在 `index.ts` 三处分流点 + 一个纯函数文件，`git revert` 即可；行为退回「结论被吞」的现状，无数据风险。
- 灰度：先在 5 号群（quietProgress:true，本 bug 现场）E2E 验证，再观察主群正常过场叙述不被误升格。

## Open Questions

- 白名单是否需要可配置（env / group_config）？本次先硬编码 `['TodoWrite']`，待出现第二个收尾型工具再考虑配置化。
- 是否要把同样的判定下沉到 CLI / print 模式？本次 Non-Goal，待确认该路径是否存在同类现象再议。

## 测试计划

分两层：**纯函数单测**（快、确定性高，覆盖判定逻辑）+ **index.ts 分流集成测试**（覆盖三处分流点的 I/O 行为）+ **真实 E2E**（飞书群端到端，覆盖 quietProgress 与中断）。

### P0（必须，阻塞合并）

纯函数单测 `isFinalizingOnly`（新增 `*.test.ts`，预计 6-8 个 case）：
- 空数组 → 视场景定义（约定：无跟随工具不属于本判定，单独说明）。
- `['TodoWrite']` → true。
- `['TodoWrite','TodoWrite']` → true。
- `['Read']` / `['Bash']` / `['Edit']` / `['Grep']` → false。
- `['TodoWrite','Read']`（收尾后跟实质）→ false。
- `['Read','TodoWrite']`（实质在前）→ false。

集成测试（mock SDK 消息流喂进 runQuery 的判定分支，预计 4-5 个 case，对应 spec 场景）：
- 结论 + 只跟 TodoWrite + result.result 为空 → 发 `status:'success'`，非 isProgress。
- 结论 + 跟 TodoWrite 后又跟 Read → 降级 `💬`（`progressType:'text'`）；验证 `followupToolsSinceText` 含实质工具时回退。
- 过场文本 + 跟 Read → 降级 `💬`（回归，行为不变）。
- 候选已标记 + result 非空到达 → 发 result、丢候选，不双发；候选 + result 为空 → 发候选。
- finally（abort）补发：候选 text 在 finally 先 clearTimeout 再发为 `status:'success'`。

### P1（应有）

真实 E2E（用大杰账号、Debug API wait=false，新建会话，逐条查 agent_messages + 用户可见面）：
- E2E-1：普通 SDK 群，结论后只跟 TodoWrite → 飞书收到独立正式结论消息（非进度卡片）。
- E2E-2：5 号群（quietProgress:true）复现 → 结论作为独立消息送达，不被折叠进卡片。
- E2E-4：过场叙述 + 实质工具 → 仍是 `💬`，未刷屏。

### P2（可选，时间允许）

- E2E-3：构造「结论后被 /model 打断」的中断场景，验证 finally 补发。此场景人工触发时序较难稳定复现，优先用集成测试覆盖，E2E 作为补充人工验证。
- E2E-5：升格后 result 重复的双发去重，优先集成测试覆盖。

### 验收口径

- P0 全绿 + 现有 agent-runner 单测回归不破，才进入 review。
- P1 的 E2E 必须核 wf 跑完后的终态数据（agent_messages 里该轮 status、用户可见的消息体），不能只看「流程跑通」。
- 判 PASS 必查用户可见面：飞书里真出现独立结论消息，而非只在 DB 里有记录。
