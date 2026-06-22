## Context

当前 Commander 协议是中心化模型：主群通过 `delegate` 给子群派工，子群通过 `report_to_main` 回唯一主群，`delegation_tasks` 只记录目标群，不记录发起群。这个模型的好处是简单、权限边界硬，但天然不支持“任意群请另一个群帮忙”。

不能只把 `isMain` 检查删掉。删掉后会出现四类问题：汇报仍回唯一主群，非主群派出的任务结果回不到发起群；`/delegate reply/retry/close` 没有 source 过滤，普通群可能管理别人的任务；自动终态兜底仍写主群；账本没有 source 字段，审计和状态表不知道任务是谁发起的。

已有约束必须保留：跨群普通 `send_message` 不放开，任务协作必须走 delegation 账本；汇报消息继续复用 message loop，不主动 enqueue，避免双投喂；目标群仍保持一群一在办，避免多个来源同时压垮同一 agent。

## Goals / Non-Goals

**Goals:**

- 让任意已注册群都可以通过 `delegate` 向其他已注册群派工。
- 让汇报、自动终态、续投都回到任务发起群，而不是固定回主群。
- 保留主群全局观察和管理能力。
- 允许普通群把任务派给主群；禁止的只是 source=target 自派。
- 保留旧主群派工能力和旧工具名 `report_to_main` 的兼容。
- 明确 schema 迁移、权限过滤、失败回滚和测试计划。

**Non-Goals:**

- 不放开任意跨群 `send_message`。
- 不支持一个目标群同时接多个在办 delegation。
- 不把 task-ledger 和 delegation_tasks 合并；本次只改 Commander 派工账本。
- 不实现复杂多级转派链路展示，只保证每条 delegation 有一个 source 和一个 target。

## Decisions

### 1. 账本升级为 source-target 双边模型

`delegation_tasks` 新增：

- `source_group TEXT NOT NULL`
- `source_jid TEXT NOT NULL`

旧数据迁移时用唯一主群回填 `source_group/source_jid`。如果无法解析唯一主群，迁移应失败并显式报错，不静默写空值。

理由：source 是权限、汇报、审计、状态表的核心维度。没有 source 字段，任何非主群派工都是假支持。

备选方案是另建 `delegation_routes` 表，但当前 delegation 是一次派工尝试，不是复杂 DAG，直接加字段更简单。

命名约束：代码里当前 IPC watcher 传入的 `sourceGroup` 实际表示“当前发 IPC 的群”。在 report 场景它是执行任务的目标群，不是任务发起群。实现时应改名或局部别名为 `reportingGroup` / `ipcSourceGroup`，DB 字段 `task.source_group` 只表示任务发起方，DB 字段 `task.target_group` 只表示任务执行方。

### 2. 目标群一在办约束继续按 target_group 执行

唯一索引继续约束占槽态下每个 `target_group` 最多一条任务，不扩展成 `(source_group, target_group)`。

理由：目标群 agent 是单会话处理者，同时接多个来源的任务会引入队列优先级和上下文污染。本次目标是安全互派，不是目标群多任务并发。

代价是多个群同时想派同一个目标群时，后来的会被拒。这个行为符合当前 Commander “一群一在办”的安全基线。

`retry` 需要保留自身占槽豁免：如果目标群当前占槽任务就是正在 retry 的 task，允许重派；如果目标群被其他 task 占槽，拒绝。

### 3. `report_to_main` 保留兼容，但语义改成 report-to-source

新增推荐工具名 `report_to_source`，旧 `report_to_main` 保留一段时间，两者都写 `type: 'report'` IPC。工具描述必须明确：host 先按 `target_group = reporting_group` 锁定当前任务，再根据 `task.source_jid` 决定投递目标；agent 不传 target、不传 task_id。

理由：直接删除 `report_to_main` 会让旧 prompt、旧会话和已有 agent 习惯断掉；保留旧名但改描述可以平滑迁移。最终可以在后续版本弃用旧名。

### 4. 普通群只管理自己发起的任务，主群全局

`/delegate status/reply/retry/close` 的授权规则：

- 普通群：只能看到和操作 `source_group = 当前群 folder` 的任务。
- 主群：可以看到和操作全部任务。

理由：主群是运维/指挥中心，需要全局兜底；普通群只能管理自己发出去的活，不能关掉别人的任务。

### 5. 汇报入库继续走 message loop

汇报写入 source_jid 对应的 messages.db，保持 `ipc_` 前缀、host timestamp、`is_from_me=false`，仍不主动 `enqueueMessageCheck`。

理由：这是现有防双投喂设计的关键。改目标群不应该改变投喂模型，否则会复活“同一条消息被 pipe 两次”的旧 bug。

## Migration Plan

1. DB migration 增加 `source_group/source_jid`，回填旧任务为唯一主群。
2. `DelegationTask` 类型和 row mapper 增加 source 字段。
3. `createDelegation()` 必须传 source 和 target；调用方全部更新。
4. `handleDelegate()` 去掉非主群拒绝，改为校验 source/target 都已注册、source != target；投递失败或目标群入库失败时必须把刚创建的 delegation 转成 failed/closed 或删除，释放 target slot，并通知 source_jid。
5. `handleReport()` 和自动终态从 `getMainGroup()` 改为：先按 `target_group = reportingGroup` 锁定 task，再读取 `task.sourceJid`。
6. `/delegate` 命令去掉 `requiresMain`，在 handler 内按任务 source 做授权过滤；主群保留全局权限。
7. MCP 工具描述更新，新增 `report_to_source`，旧 `report_to_main` 兼容。
8. 补齐单测和 IPC 集成测试。

Rollback 策略：如果上线后发现问题，可先恢复工具层限制，重新让 `delegate` 只允许主群调用；DB 新增字段保留不影响旧主群派工。

## Risks / Trade-offs

- [Risk] 旧任务没有 source 字段导致运行时空值 → migration 必须回填唯一主群；无法解析唯一主群时启动失败比静默串群更安全。
- [Risk] `sourceGroup` 旧变量名误导实现者把 report 查询写成 `source_group = reportingGroup` → report 路径必须统一命名：IPC 当前群叫 `reportingGroup/ipcSourceGroup`，DB 发起方叫 `task.source_group`，DB 执行方叫 `task.target_group`。
- [Risk] 普通群越权管理别人的任务 → 所有 `/delegate` 子命令必须统一走 `canManageDelegation(currentGroup, task)` 纯函数，测试覆盖主群/普通群两类。
- [Risk] report 工具名仍叫 `report_to_main` 让模型误解 → 新增 `report_to_source`，旧名描述写“兼容旧名，不再固定主群”，并在 prompt 中优先暴露新名。
- [Risk] 多源同时派同一目标群被拒影响体验 → 明确提示目标群当前占槽任务和发起群，建议 retry/close，不引入并发队列。
- [Risk] 先落账后投递失败留下 dispatched 幽灵占槽 → `handleDelegate()` 的发送失败和目标群入库失败两个 catch 分支必须统一释放槽位，并把失败通知写回 source_jid。
- [Risk] 汇报投递 source_jid 后发起群 requiresTrigger 导致不处理 → 继续用 `ipc_` 前缀和 message loop trigger bypass 机制，测试覆盖非主群 source 收到汇报后能被扫到。

## Open Questions

- 旧工具名 `report_to_main` 是长期保留还是后续版本移除？建议先兼容保留，等观察模型调用稳定后再删。
- 主群是否能强制关闭普通群发起的任务？本方案认为可以，主群是全局运维兜底。
- `/delegate status [group]` 的 group 参数对主群应默认匹配 source 还是 target？建议两者都匹配，并在表格同时显示 source/target。

## 测试计划

### P0 核心测试

- `db.ts` migration：新增 source 字段、旧任务回填、无唯一主群时报错。
- `createDelegation()`：必须写入 source 和 target，缺字段失败。
- `handleDelegate()`：普通群可派给其他群，未注册 target、自派、目标占槽被拒。
- `handleDelegate()` 投递失败回滚：发送失败、目标群入库失败都释放 target slot 并通知 source_jid。
- `handleReport()`：目标群 report 后按 `target_group = reportingGroup` 锁定任务，再投递到 task.source_jid，不再固定主群。
- 自动终态：目标群正常结束/异常结束分别向 source_jid 写 done/failed。
- `/delegate reply/retry/close`：普通群只能操作自己 source 的任务，主群可全局操作。

### P1 重要测试

- `report_to_main` 旧名兼容，行为等价 `report_to_source`。
- 非主群派工给主群被允许，主群给自己派工被 source=target 自派规则拒绝。
- retry 同一 task 时允许自身占槽豁免，retry 其他 task 时仍受目标群占槽限制。
- 多条汇报同毫秒写入同一个 source_jid 时 timestamp 单调递增。
- source 群 requiresTrigger=true 时，`ipc_` 汇报仍能被 message loop 扫到。
- 飞书发送失败、飞书发送成功但目标群入库失败时，都回滚任务槽位并通知 source 群。

### P2 回归测试

- 现有主群派工 E2E 仍通过。
- `/delegate status` 渲染同时展示 source/target。
- task_id 前缀注入格式不变，旧子群任务识别不受影响。

预计新增/更新 30-40 个单测，重点覆盖 `delegation.test.ts`、`ipc.test.ts`、`commands/delegate.test.ts`、`ipc-mcp-stdio` 相关测试。
