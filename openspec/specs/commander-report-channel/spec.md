# commander-report-channel Specification

## Purpose
TBD - created by archiving change commander-protocol. Update Purpose after archive.
## Requirements
### Requirement: 子群受限汇报通道

子群 SHALL 只能通过 `report_to_main` 工具向**唯一主群**汇报，不得指定任意目标群。`report_to_main` 不接受 target 参数，目标群由 host 端解析为唯一 isMain 群。子群对任意群的 `send_message` 授权 SHALL 保持不放开（`ipc.ts` 授权逻辑不变）。

#### Scenario: 子群正常汇报
- **WHEN** 子群 agent 调用 `report_to_main(status='done', summary='修复完成')`
- **THEN** host SHALL 写 `type: 'report'` IPC，解析唯一主群 jid，把汇报投递到主群 messages.db

#### Scenario: 子群尝试发到任意群被拒
- **WHEN** 子群 agent 调用 `send_message(target='2号', text=...)` 想发给别的子群
- **THEN** host SHALL 按现有授权逻辑拒绝并记 warn，不放开通用跨群发送

#### Scenario: 主群误用 report_to_main
- **WHEN** 主群 agent 调用 `report_to_main(...)`
- **THEN** host SHALL 拒绝（源群为 main 不该汇报给自己）并记 warn

#### Scenario: main 群数量异常
- **WHEN** 处理 report 时注册群中 isMain 群数量为 0 或大于 1
- **THEN** host SHALL 抛错而非静默降级，避免汇报投递到错误群

### Requirement: 汇报状态枚举

`report_to_main` 的 status SHALL 限定为 `progress` / `done` / `blocked` / `failed` / `question` 五种之一。payload SHALL 固定字段 `status` / `summary` / `details?` / `artifacts?`，SHALL NOT 含 task_id 参数（task_id 由 host 用 source_group 锁定）。

#### Scenario: 非法 status 被拒（工具层 + host 双重校验）
- **WHEN** agent 传入 `status='finished'`（不在枚举内）
- **THEN** 工具层 SHALL 拒绝该调用并提示合法取值
- **AND** host 端 SHALL 不信任工具层 schema，独立用白名单校验 status（绕过 schema 直接写 IPC 文件注入 `closed`/`dispatched`/任意值的汇报 SHALL 被 host 丢弃）

#### Scenario: artifacts 合法路径记账本
- **WHEN** 汇报带 `artifacts=['<group workspace>/diff.patch']`（命中白名单）
- **THEN** host SHALL path.resolve 校验通过后记入账本 artifacts 字段，主群可直接按宿主机路径读取，不经飞书云盘

#### Scenario: artifacts 非法路径降级
- **WHEN** 汇报带 `artifacts=['/Users/dajay/.ssh/id_rsa']`（未命中白名单或命中敏感子路径黑名单）
- **THEN** host SHALL NOT 记入 artifacts 字段，SHALL 降级为 details 里的纯文本备注并记 warn，且 SHALL NOT 因此中断汇报

### Requirement: 汇报复用 message loop 限流

汇报消息入主群 messages.db 时 SHALL 使用 **host 入库时刻** timestamp、`ipc_` 前缀（绕过 trigger）、`is_from_me=false`。host SHALL NOT 对汇报消息主动调用 `enqueueMessageCheck`，统一交给 message loop 发现处理，使同一 poll 周期内的多条汇报合并为一次 context。同一主群的 `ipc_` 汇报 timestamp SHALL 严格单调递增（host 按 jid 记录上次毫秒值，撞同毫秒时 +1），避免 message loop 的 `timestamp > lastTimestamp` 游标停在某毫秒后跳过同毫秒的后续汇报。

#### Scenario: 多子群同时汇报不刷屏
- **WHEN** 一个 poll 周期内有 10 个子群各 report 一次
- **THEN** message loop SHALL 在下一周期一次性扫到全部 10 条并合并喂给主群 agent，主群 SHALL 只被触发处理一次，不产生 10 次独立投喂

#### Scenario: 同毫秒多条汇报不被游标跳过
- **WHEN** 多条汇报在同一毫秒写入主群 messages.db
- **THEN** host SHALL 给它们发放严格递增的 timestamp（同毫秒 +1），使 message loop 的 `timestamp > lastTimestamp` 不会因游标停在该毫秒而漏扫后续汇报

### Requirement: task_id 由 host 用 source_group 锁定

agent SHALL NOT 传 task_id；host SHALL 用 source_group 反查该群唯一非终态 delegation 任务（依赖"一群一在办任务"约束保证唯一）来锁定 task_id。若该群无在办任务，host SHALL 记 warn 并**拒绝该汇报**（不更新账本、不投递主群）——汇报通道只服务于已派工任务，无 task 锁定的汇报视为越界，不得成为子群任意向主群发消息的旁路。

#### Scenario: host 用 source_group 锁定任务
- **WHEN** 子群 report，且该群有一条 status=progress 的 delegation
- **THEN** host SHALL 用 `getActiveDelegationByGroup(sourceGroup)` 命中该唯一任务并更新其状态

### Requirement: 子群一轮结束自动终态兜底汇报

`report_to_main` 是子群主动汇报的主路径，但 agent 可能正常干完却忘了调用，导致账本停在 dispatched/progress 直到 15 分钟失联才暴露。host SHALL 在子群 agent「一轮 query 结束」的信号处兜底：若该子群仍有**进行态**（dispatched/progress）delegation 任务，host SHALL 自动补一条终态汇报（成功结束补 `done`、异常结束补 `failed`），更新账本并投递主群。

自动兜底 SHALL 仅对进行态生效：等待态（blocked/question）是 agent 主动留给主群的信号，SHALL NOT 被自动 done/failed 覆盖；关闭态（done/failed/closed）已结束，`getActiveDelegationByGroup` 查不到，天然跳过。因此 agent 若已自主汇报，自动兜底 SHALL NOT 重复触发。

自动兜底汇报 SHALL 携带子群本轮最终回复作为结果摘要（写入账本 details 字段并在投递主群的汇报消息里带上），截断到 2000 字防超长，避免主群只收到「host 自动标记完成」却不知道完成了什么。子群本轮无回复内容时 details SHALL 留空，不写无意义占位。

#### Scenario: 子群干完忘了汇报
- **WHEN** 子群处理完派工消息、正常结束一轮 query，但全程未调用 `report_to_main`，任务仍为 dispatched/progress
- **THEN** host SHALL 自动补一条 `done` 汇报投递主群并把账本置 done，主群 SHALL 不必等 15 分钟失联

#### Scenario: 子群容器异常结束
- **WHEN** 子群容器以 error 状态退出，任务仍为 dispatched/progress
- **THEN** host SHALL 自动补一条 `failed` 汇报并把账本置 failed

#### Scenario: agent 主动留 question 不被自动 done 覆盖
- **WHEN** 子群 agent 调用 `report_to_main(status='question')` 后结束一轮 query
- **THEN** host 自动兜底 SHALL NOT 触发（question 是等待态），账本保持 question 等主群续投

#### Scenario: 子群无在办任务时汇报被拒
- **WHEN** 子群 report 但该群账本无任何非终态 delegation
- **THEN** host SHALL 记 warn 并丢弃该汇报，SHALL NOT 更新任何账本行，且 SHALL NOT 投递主群

