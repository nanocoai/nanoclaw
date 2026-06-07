# commander-delegation Specification

## Purpose
TBD - created by archiving change commander-protocol. Update Purpose after archive.
## Requirements
### Requirement: 主群派工落账本

主群 SHALL 通过 `delegate(target, text, title?)` 工具派活。`delegate` SHALL NOT 接受 task_id 参数（task_id 完全由 host 生成）。host 处理 `type: 'delegate'` IPC 时 SHALL **先在 delegation_tasks 落一行**（生成 task_id、status=dispatched）再投递消息到子群，保证不出现"已投递但账本无记录"的悬空状态。`delegate` SHALL 仅主群可用。host SHALL 强制**一群一在办任务**：若目标子群已有非终态（dispatched/progress/blocked/question）delegation，SHALL 拒绝本次派工并提示主群。

#### Scenario: 主群派活
- **WHEN** 主群 agent 调用 `delegate(target='3号', text='修复登录超时', title='登录超时修复')`
- **THEN** host SHALL 先 createDelegation 生成 task_id（status=dispatched），再把消息投递到 3 号群，并回写 dispatch_msg_id

#### Scenario: 目标群已有在办任务被拒
- **WHEN** 主群对一个已有 status=progress delegation 的子群再次 `delegate(...)`
- **THEN** host SHALL 拒绝并提示主群"该群有在办任务，先处理或 retry"，SHALL NOT 新建第二条 delegation

#### Scenario: task_id 注入投递消息
- **WHEN** host 投递派发消息到子群
- **THEN** 投递文本 SHALL 由 host 注入 task_id 标记（如 `[task_id:dlg_xxx]`），不依赖 agent 自行生成或携带

#### Scenario: 子群误用 delegate
- **WHEN** 子群 agent 调用 `delegate(...)`
- **THEN** host SHALL 拒绝（非主群无派工权限）并记 warn

### Requirement: 派工状态机

delegation 任务状态 SHALL 在 dispatched / progress / done / blocked / failed / question / closed 之间流转（timeout 为渲染显示态，不落库）。状态分三类：**进行态** dispatched/progress（占在办槽位 + 参与失联判定）、**等待态** blocked/question（占槽 + 不标失联）、**关闭态** done/failed/closed（释放槽位）。占槽态（dispatched/progress/blocked/question）SHALL 占用"一群一在办任务"槽位，直到经 reply/retry 推进或 close/done/failed 关闭。汇报到达时 SHALL 更新 status、summary、details、artifacts、last_report_at。

#### Scenario: 汇报推进状态
- **WHEN** 子群对某 task report status=progress 再 report status=done
- **THEN** 账本该行 status SHALL 依次更新为 progress 再 done，并刷新 last_report_at

#### Scenario: question 占槽留待主群续投
- **WHEN** 子群 report status=question
- **THEN** 账本 SHALL 标记 question（占槽、不标失联），汇报进主群让主群 agent 看到；系统 SHALL NOT 自动流转，由主群通过 `/delegate reply <task_id> <text>` 续投推进（不能再 `delegate` 新建，会被一群一在办任务约束挡住）

### Requirement: delegate 命令族与超时惰性判定

主群 SHALL 提供 `/delegate status [group]`、`/delegate reply <task_id> <text>`、`/delegate retry <task_id>`、`/delegate close <task_id>` 命令（requiresMain）。`/delegate status` 渲染时 SHALL **仅对 status ∈ {dispatched, progress}** 的任务做超时惰性判定：`now - last_report_at`（无汇报则 `now - dispatched_at`）超阈值（默认 15 分钟）的任务显示失联标记，但 SHALL NOT 修改 DB 中的 status。等待态 blocked/question 与关闭态 done/failed/closed SHALL NOT 标失联。

#### Scenario: 查看派工状态
- **WHEN** 主群执行 `/delegate status`
- **THEN** SHALL 表格列出各任务的 task_id 短码、target、status、最后汇报时间、summary 截断

#### Scenario: 失联任务标记
- **WHEN** 某 dispatched 任务超过阈值仍无任何汇报
- **THEN** `/delegate status` SHALL 显示 ⚠️ 失联标记，但账本 status 仍保持 dispatched（不静默改写）

#### Scenario: blocked/question 不标失联
- **WHEN** 某任务 status=blocked 或 question 且超过阈值
- **THEN** `/delegate status` SHALL NOT 标失联（blocked 是已知卡住态、question 是等待主群答复态，球不在子群侧）

#### Scenario: 重派任务
- **WHEN** 主群执行 `/delegate retry <task_id>`
- **THEN** host SHALL 读原 title 重新 delegate 到原 target group，并将该任务状态回置 dispatched

#### Scenario: 续投回答 question 任务
- **WHEN** 某任务 status=question，主群执行 `/delegate reply <task_id> 用方案 A`
- **THEN** host SHALL 把 `[task_id:xxx]\n用方案 A` 投到账本里的原 target_jid（不新建 task、不改 task_id），并将状态回置 progress

#### Scenario: reply 仅限占槽进行/等待态
- **WHEN** 主群对一个 status=done（关闭态）的 task 执行 `/delegate reply`
- **THEN** host SHALL 拒绝（仅 progress/blocked/question 可续投），提示该任务已关闭

#### Scenario: 关闭任务释放槽位
- **WHEN** 主群对一个卡死的 status=blocked task 执行 `/delegate close <task_id>`
- **THEN** host SHALL 将状态置为 closed（关闭态），释放该子群的在办任务槽位，使新的 `delegate` 可派发

