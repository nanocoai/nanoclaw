## MODIFIED Requirements

### Requirement: 子群受限汇报通道

目标群 SHALL 只能通过受限汇报工具向**任务发起群**汇报，不得指定任意目标群。兼容期内保留 `report_to_main` 工具名，但工具描述 SHALL 明确其实际语义为“report to source”；系统 MAY 新增推荐工具名 `report_to_source`，两者 SHALL 写入同一种 `type: 'report'` IPC。目标群不接受 target 参数，目标群由 host 端根据当前 IPC 来源群（下称 `reporting_group`，即正在执行任务的目标群 folder）反查 `target_group = reporting_group` 的当前在办任务，再从任务账本读取 `task.source_jid`。子群对任意群的 `send_message` 授权 SHALL 保持不放开（`ipc.ts` 授权逻辑不变）。

#### Scenario: 目标群正常汇报给发起群
- **WHEN** 3 号群 agent 调用 `report_to_source(status='done', summary='修复完成')`
- **THEN** host SHALL 用 `target_group = reporting_group = 3号群 folder` 反查当前在办任务，读取该任务 `source_jid`，并把汇报投递到任务发起群 messages.db

#### Scenario: 旧工具名兼容
- **WHEN** 3 号群 agent 调用旧工具名 `report_to_main(status='done', summary='完成')`
- **THEN** host SHALL 按 report-to-source 语义处理，投递到任务 source_jid，而不是无条件投递唯一主群

#### Scenario: 子群尝试发到任意群被拒
- **WHEN** 子群 agent 调用 `send_message(target='2号', text=...)` 想发给别的子群
- **THEN** host SHALL 按现有授权逻辑拒绝并记 warn，不放开通用跨群发送

#### Scenario: 发起群误用 report 被拒
- **WHEN** 某群对自己发起但尚未作为目标接活的任务调用 report 工具
- **THEN** host SHALL 因该群作为 `reporting_group` 时没有匹配的 `target_group` 在办任务而拒绝，SHALL NOT 把 report 当成普通跨群消息通道

### Requirement: task_id 由 host 用 reporting_group 锁定

agent SHALL NOT 传 task_id；host SHALL 用 report IPC 的当前群 folder（`reporting_group` / `ipc_source_group`，即当前正在执行任务的目标群）反查 `target_group = reporting_group` 的唯一非终态 delegation 任务（依赖"一目标群一在办任务"约束保证唯一）来锁定 task_id。`reporting_group` SHALL NOT 被命名或写入为 `task.source_group`，因为 `task.source_group` 表示任务发起群，语义相反。若该目标群无在办任务，host SHALL 记 warn 并**拒绝该汇报**（不更新账本、不投递任何群）——汇报通道只服务于已派工任务，无 task 锁定的汇报视为越界，不得成为任意向其他群发消息的旁路。

#### Scenario: host 用目标群锁定任务
- **WHEN** 3 号群 report，且该群有一条 status=progress 的 delegation
- **THEN** host SHALL 用 `getActiveDelegationByGroup(reportingGroup)` 或等价查询 `WHERE target_group = reporting_group` 命中该唯一任务，更新其状态，并把汇报投递到 `task.source_jid`

#### Scenario: 目标群无在办任务时汇报被拒
- **WHEN** 3 号群 report 但该群账本无任何非终态 delegation
- **THEN** host SHALL 记 warn 并丢弃该汇报，SHALL NOT 更新任何账本行，且 SHALL NOT 投递任何群

### Requirement: 汇报复用 message loop 限流

汇报消息入发起群 messages.db 时 SHALL 使用 **host 入库时刻** timestamp、`ipc_` 前缀（绕过 trigger）、`is_from_me=false`。host SHALL NOT 对汇报消息主动调用 `enqueueMessageCheck`，统一交给 message loop 发现处理，使同一 poll 周期内的多条汇报合并为一次 context。同一发起群的 `ipc_` 汇报 timestamp SHALL 严格单调递增（host 按 jid 记录上次毫秒值，撞同毫秒时 +1），避免 message loop 的 `timestamp > lastTimestamp` 游标停在某毫秒后跳过同毫秒的后续汇报。

#### Scenario: 多目标群同时回同一发起群不刷屏
- **WHEN** 一个 poll 周期内有 10 个目标群各 report 一次，且 source_jid 相同
- **THEN** message loop SHALL 在下一周期一次性扫到全部 10 条并合并喂给发起群 agent，发起群 SHALL 只被触发处理一次，不产生 10 次独立投喂

#### Scenario: 同毫秒多条汇报不被游标跳过
- **WHEN** 多条汇报在同一毫秒写入同一发起群 messages.db
- **THEN** host SHALL 给它们发放严格递增的 timestamp（同毫秒 +1），使 message loop 的 `timestamp > lastTimestamp` 不会因游标停在该毫秒而漏扫后续汇报

### Requirement: 子群一轮结束自动终态兜底汇报

汇报工具是目标群主动汇报的主路径，但 agent 可能正常干完却忘了调用，导致账本停在 dispatched/progress 直到 15 分钟失联才暴露。host SHALL 在目标群 agent「一轮 query 结束」的信号处兜底：若该目标群仍有**进行态**（dispatched/progress）delegation 任务，host SHALL 自动补一条终态汇报（成功结束补 `done`、异常结束补 `failed`），更新账本并投递任务发起群。

自动兜底 SHALL 仅对进行态生效：等待态（blocked/question）是 agent 主动留给发起群的信号，SHALL NOT 被自动 done/failed 覆盖；关闭态（done/failed/closed）已结束，`getActiveDelegationByGroup` 查不到，天然跳过。因此 agent 若已自主汇报，自动兜底 SHALL NOT 重复触发。

自动兜底汇报 SHALL 携带目标群本轮最终回复作为结果摘要（写入账本 details 字段并在投递发起群的汇报消息里带上），截断到 2000 字防超长，避免发起群只收到「host 自动标记完成」却不知道完成了什么。目标群本轮无回复内容时 details SHALL 留空，不写无意义占位。

#### Scenario: 目标群干完忘了汇报
- **WHEN** 目标群处理完派工消息、正常结束一轮 query，但全程未调用汇报工具，任务仍为 dispatched/progress
- **THEN** host SHALL 自动补一条 `done` 汇报投递发起群并把账本置 done，发起群 SHALL 不必等 15 分钟失联

#### Scenario: 目标群容器异常结束
- **WHEN** 目标群容器以 error 状态退出，任务仍为 dispatched/progress
- **THEN** host SHALL 自动补一条 `failed` 汇报并把账本置 failed，汇报投递任务发起群

#### Scenario: agent 主动留 question 不被自动 done 覆盖
- **WHEN** 目标群 agent 调用汇报工具 `status='question'` 后结束一轮 query
- **THEN** host 自动兜底 SHALL NOT 触发（question 是等待态），账本保持 question 等发起群续投
