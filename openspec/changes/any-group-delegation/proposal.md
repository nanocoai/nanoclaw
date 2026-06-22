## Why

NanoClaw 当前 Commander 协议只支持“唯一主群派工给子群，子群回报唯一主群”。这个中心化模型能跑主群指挥，但不能支持任意群把任务委托给另一个群，继续硬放开 `isMain` 检查会导致汇报投错、任务续投串群、状态表越权和幽灵任务占槽。

本变更把派工账本从“目标群单边记录”升级为“source → target 双边记录”，让任意已注册群都能安全派工，同时保留主群全局观察和现有主群派工兼容路径。

## What Changes

- `delegation_tasks` 新增发起方字段：`source_group`、`source_jid`，并迁移旧数据为 source=唯一主群。
- `delegate` MCP 工具从“主群专用”升级为“已注册群可用”，host 端按 source group 落账并投递目标群。
- `/delegate` 命令族从“主群管理全部任务”升级为“普通群管理自己发起的任务，主群可全局观察/管理”。
- `report_to_main` 兼容保留工具名，但语义升级为“report to source”：子群汇报回任务发起群；新增描述或别名 `report_to_source`，避免模型继续误解成只能回主群。
- 自动终态兜底从“写入唯一主群”改为“写入该任务 source_jid”。
- main 群可以作为 target 被其他群派工；唯一禁止的是 source=target 自派。
- 保留一群一在办约束，但约束对象仍是 target group：一个目标群同一时刻最多处理一个 delegation，避免目标群被多个来源同时压垮。
- 保留跨群普通 `send_message` 限制：任务型跨群协作必须走 delegate 账本，不放开任意跨群发消息旁路。

## Capabilities

### New Capabilities

无。本变更是扩展现有 Commander 派工与汇报能力，不引入独立新能力。

### Modified Capabilities

- `commander-delegation`: 将派工入口从主群专用升级为任意注册群可发起，并增加 source/target 双边账本与权限过滤。
- `commander-report-channel`: 将汇报目标从唯一主群升级为任务发起群，保留旧工具名兼容并增加回源群语义。

## Impact

- 数据库：`delegation_tasks` schema、迁移逻辑、索引和唯一约束。
- Host IPC：`handleDelegate()`、`handleReport()`、自动终态兜底、跨群投递失败回滚。
- MCP 工具描述：`delegate`、`report_to_main`，可选新增 `report_to_source` 作为推荐工具名。
- 命令：`/delegate status/reply/retry/close` 的权限过滤和主群全局能力。
- 测试：`delegation.test.ts`、`commands/delegate.test.ts`、`ipc.test.ts` 需要覆盖普通群派工、汇报回源群、越权管理拒绝、旧任务迁移兼容。
