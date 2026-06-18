## ADDED Requirements

### Requirement: 收尾型工具白名单不降级最终文本

系统 SHALL 维护一个「收尾型工具白名单」（finalizing tools），白名单内的工具是纯记账、对用户和外部系统均无副作用的工具（如 `TodoWrite`）。当一段缓存的 assistant 文本块后面**只**跟随白名单内的工具调用、不含任何白名单之外的实质工具时，系统 MUST 将这段文本作为正式回复（`status:'success'`）发出，而 MUST NOT 将其降级为 `💬` 中间叙述进度。

#### Scenario: 文本后只跟 TodoWrite

- **WHEN** assistant 在同一轮先产出一段可见文本（结论），随后只调用 `TodoWrite`，其 tool_result 到达
- **THEN** 系统把这段文本作为 `status:'success'` 的正式回复发出，宿主端走 `channel.sendMessage`（非 isProgress）独立发送完整文本

#### Scenario: 文本后跟实质工具时仍降级

- **WHEN** assistant 产出一段文本后，跟随了一个白名单之外的实质工具（如 `Read`/`Bash`/`Edit`/`Grep`），其 tool_result 到达
- **THEN** 系统仍把这段文本降级为 `💬` 中间叙述进度（`progressType:'text'`），行为与现状一致

#### Scenario: 文本后先跟收尾工具再跟实质工具

- **WHEN** assistant 产出文本后先调用 `TodoWrite`，但在本段文本被升格发出前，又出现了一个白名单之外的实质工具
- **THEN** 系统将该文本判定为中间叙述并降级为 `💬`，不升格为正式回复（实质工具的出现表明 agent 仍在继续干活）

### Requirement: 轮次中断时的兜底投递

当 `runQuery` 因 abort、错误或 SDK 异常退出而走 `finally` 清理路径时，若缓存中仍存在被判定为「候选最终回复」的文本（后面只跟随收尾型工具），系统 MUST 将其补发为正式回复，而 MUST NOT 直接丢弃。`finally` 补发前 MUST 先清除该文本的兜底定时器（防止异步定时器在本轮 `runQuery` 返回后误触发、把本轮缓存写进后续轮次的输出流）。

#### Scenario: result 未到达即被打断

- **WHEN** assistant 产出结论文本（后面只跟收尾工具）后，该轮在 SDK `result` 消息到达前被 `/model` 切换等操作中断，触发 `finally`
- **THEN** 系统在 `finally` 中把缓存的候选结论文本补发为正式回复，用户仍能收到该结论

#### Scenario: finally 补发先清定时器

- **WHEN** `finally` 执行补发逻辑
- **THEN** 系统先清除该缓存文本的 30s 兜底定时器再补发，确保定时器不会在本轮返回后再次触发输出

### Requirement: 正式回复不双发

「升格/补发候选文本」与「发出 SDK `result` 文本」在同一轮内 MUST 互斥：当 SDK `result` 携带非空文本时，系统 MUST 发出 `result` 文本并丢弃候选缓存；仅当 `result` 文本为空、或 `result` 因中断永不到达时，系统才发出候选文本。系统 MUST NOT 在同一轮把同一结论既以候选升格、又以 `result` 重复发出。

#### Scenario: result 非空时发 result 丢候选

- **WHEN** 某段文本已被标记为候选最终回复，随后 SDK `result` 消息携带非空文本到达
- **THEN** 系统发出 `result` 文本作为正式回复，并丢弃候选缓存，不重复发送

#### Scenario: result 为空时发候选

- **WHEN** 某段文本被标记为候选最终回复，随后 SDK `result` 消息携带空文本到达
- **THEN** 系统把候选文本作为正式回复发出

### Requirement: quietProgress 群正式回复不被埋没

在 `quietProgress:true` 的群中，被判定为正式回复的文本 MUST 通过正式回复路径（独立消息）送达用户，MUST NOT 因为安静模式而被折叠进进度卡片。`💬` 中间叙述在安静模式下被折叠进卡片的现有行为保持不变。

#### Scenario: quietProgress 群收到升格的正式回复

- **WHEN** 群配置 `quietProgress:true`，agent 的结论文本被升格为 `status:'success'` 正式回复
- **THEN** 宿主端走正式回复路径独立发送完整文本，不进进度卡片
