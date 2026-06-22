# commander-delegation Specification

## Purpose

定义 NanoClaw Commander 协议的跨群派工账本、权限边界、目标群占槽和派工命令语义。

## Requirements

### Requirement: 主群派工落账本

已注册群 SHALL 通过 `delegate(target, text, title?)` 工具派活。`delegate` SHALL NOT 接受 task_id 参数（task_id 完全由 host 生成）。host 处理 `type: 'delegate'` IPC 时 SHALL **先在 delegation_tasks 落一行**（生成 task_id、写入 source_group/source_jid、target_group/target_jid、status=dispatched）再投递消息到目标群，保证不出现"已投递但账本无记录"的悬空状态。

`delegate` SHALL 对所有已注册群可用，但 host SHALL 拒绝未注册 source、未注册 target、source=target 自派等无效派工。main 群 SHALL 可以作为 target 被其他群派工；原先“不能派给主群”的限制仅适用于主群给自己派工这一类 source=target 自派。主群不再是唯一可发起方，但主群 SHALL 保留全局观察和管理能力。

host SHALL 强制**一目标群一在办任务**：若目标群已有非终态（dispatched/progress/blocked/question）delegation，SHALL 拒绝本次派工并提示发起群。

host 在先落账后投递目标群的过程中，若飞书发送失败或目标群 messages.db 入库失败，SHALL 立即把刚创建的 delegation 转为非占槽终态（failed 或 closed，推荐 failed 并记录失败摘要）或删除该行，释放 target_group 在办槽位，并向 source_jid 写入失败通知。host SHALL NOT 留下 status=dispatched/progress/blocked/question 的幽灵占槽任务。

#### Scenario: 主群派活
- **WHEN** 主群 agent 调用 `delegate(target='3号', text='修复登录超时', title='登录超时修复')`
- **THEN** host SHALL 先 createDelegation 生成 task_id（source_group=主群 folder, target_group=3号群 folder, status=dispatched），再把消息投递到 3 号群，并回写 dispatch_msg_id

#### Scenario: 非主群派活
- **WHEN** 2 号群 agent 调用 `delegate(target='3号', text='检查构建失败', title='构建失败排查')`
- **THEN** host SHALL 生成 task_id，写入 source_group=2号群 folder、source_jid=2号群 jid、target_group=3号群 folder、target_jid=3号群 jid，并把带 task_id 的任务消息投递到 3 号群

#### Scenario: 非主群派工给主群
- **WHEN** 2 号群 agent 调用 `delegate(target='主群', text='请主群协调评审')`
- **THEN** host SHALL 允许该派工，写入 source_group=2号群 folder、target_group=主群 folder，并把带 task_id 的任务消息投递到主群

#### Scenario: 目标群已有在办任务被拒
- **WHEN** 任意发起群对一个已有 status=progress delegation 的目标群再次 `delegate(...)`
- **THEN** host SHALL 拒绝并提示发起群"该群有在办任务，先处理或 retry"，SHALL NOT 新建第二条 delegation

#### Scenario: task_id 注入投递消息
- **WHEN** host 投递派发消息到目标群
- **THEN** 投递文本 SHALL 由 host 注入 task_id 标记（如 `[task_id:dlg_xxx]`），不依赖 agent 自行生成或携带

#### Scenario: 投递失败回滚槽位
- **WHEN** host 已 createDelegation 生成 task_id，但发送到目标群失败或写入目标群 messages.db 失败
- **THEN** host SHALL 将该 task 转为非占槽终态或删除，释放 target_group 在办槽位，并向 task.source_jid 写入派工失败通知
- **AND** `/delegate status` SHALL NOT 再把该 task 视为占槽在办任务

#### Scenario: 未注册群误用 delegate
- **WHEN** 未注册 source group 或无法解析 target 的 agent/IPC 调用 `delegate(...)`
- **THEN** host SHALL 拒绝派工、记 warn，并 SHALL NOT 写入 delegation_tasks

#### Scenario: 自派被拒
- **WHEN** 某群调用 `delegate(target=<自己>, text=...)`
- **THEN** host SHALL 拒绝并提示不能给自己派工，避免生成自注入任务消息

### Requirement: delegate 命令族与超时惰性判定

系统 SHALL 提供 `/delegate status [group]`、`/delegate reply <task_id> <text>`、`/delegate retry <task_id>`、`/delegate close <task_id>` 命令。普通群 SHALL 只能查看和管理自己 source_group 发起的任务；主群 SHALL 可查看和管理全部任务，并可按 source 或 target 过滤。`/delegate status` 渲染时 SHALL **仅对 status ∈ {dispatched, progress}** 的任务做超时惰性判定：`now - last_report_at`（无汇报则 `now - dispatched_at`）超阈值（默认 15 分钟）的任务显示失联标记，但 SHALL NOT 修改 DB 中的 status。等待态 blocked/question 与关闭态 done/failed/closed SHALL NOT 标失联。

#### Scenario: 普通群查看自己发起的派工状态
- **WHEN** 2 号群执行 `/delegate status`
- **THEN** SHALL 只列出 source_group=2号群 folder 的任务，表格列出 task_id 短码、source、target、status、最后汇报时间、summary 截断

#### Scenario: 主群查看全局派工状态
- **WHEN** 主群执行 `/delegate status`
- **THEN** SHALL 列出全部 delegation，并展示 source 和 target，支持按 group 参数过滤 source 或 target

#### Scenario: 普通群越权续投被拒
- **WHEN** 2 号群执行 `/delegate reply <task_id>`，但该 task 的 source_group 不是 2 号群
- **THEN** host SHALL 拒绝并提示无权管理该任务，SHALL NOT 投递续投消息，也 SHALL NOT 改变任务状态

#### Scenario: 重派任务
- **WHEN** 有权限的发起群执行 `/delegate retry <task_id>`
- **THEN** host SHALL 读原 title 重新 delegate 到原 target group，并将该任务状态回置 dispatched；若目标群当前占槽任务正是该 task_id，retry SHALL 允许自身占槽豁免；若目标群被另一个占槽任务占用，retry SHALL 被拒绝

#### Scenario: 续投回答 question 任务
- **WHEN** 某任务 status=question，发起群执行 `/delegate reply <task_id> 用方案 A`
- **THEN** host SHALL 把 `[task_id:xxx]\n用方案 A` 投到账本里的原 target_jid（不新建 task、不改 task_id），并将状态回置 progress

#### Scenario: reply 仅限占槽进行/等待态
- **WHEN** 发起群对一个 status=done（关闭态）的 task 执行 `/delegate reply`
- **THEN** host SHALL 拒绝（仅 progress/blocked/question 可续投），提示该任务已关闭

#### Scenario: 关闭任务释放槽位
- **WHEN** 有权限的发起群对一个卡死的 status=blocked task 执行 `/delegate close <task_id>`
- **THEN** host SHALL 将状态置为 closed（关闭态），释放该目标群的在办任务槽位，使新的 `delegate` 可派发

### Requirement: 派工状态机

delegation 任务状态 SHALL 在 dispatched / progress / done / blocked / failed / question / closed 之间流转（timeout 为渲染显示态，不落库）。状态分三类：**进行态** dispatched/progress（占目标群在办槽位 + 参与失联判定）、**等待态** blocked/question（占槽 + 不标失联）、**关闭态** done/failed/closed（释放槽位）。占槽态（dispatched/progress/blocked/question）SHALL 占用"一目标群一在办任务"槽位，直到经 reply/retry 推进或 close/done/failed 关闭。汇报到达时 SHALL 更新 status、summary、details、artifacts、last_report_at。

#### Scenario: 汇报推进状态
- **WHEN** 目标群对某 task report status=progress 再 report status=done
- **THEN** 账本该行 status SHALL 依次更新为 progress 再 done，并刷新 last_report_at

#### Scenario: question 占槽留待发起群续投
- **WHEN** 目标群 report status=question
- **THEN** 账本 SHALL 标记 question（占槽、不标失联），汇报进发起群让发起群 agent 看到；系统 SHALL NOT 自动流转，由发起群通过 `/delegate reply <task_id> <text>` 续投推进（不能再 `delegate` 新建，会被一目标群一在办任务约束挡住）
