## 1. 数据层：delegation_tasks 账本

- [x] 1.1 `src/db.ts` 初始化块加 `CREATE TABLE IF NOT EXISTS delegation_tasks`（含索引 target_group、status）
- [x] 1.2 `createDelegation({targetGroup, targetJid, title})` → 生成 task_id、status=dispatched、落行
- [x] 1.3 `updateDelegationOnReport({taskId, status, summary, details, artifacts})` → 更新 + last_report_at
- [x] 1.4 `getDelegation(taskId)` / `listDelegations(filter?)`
- [x] 1.5 `getActiveDelegationByGroup(targetGroup)` → 反查该群唯一占槽态任务（dispatched/progress/blocked/question，task_id 锁定 + 一群一任务约束判定）
- [x] 1.6 `getMainGroup()` → registeredGroups 中唯一 isMain 群，0 或 >1 时抛错
- [x] 1.7 db 层单测（建表、增改查、兜底反查、唯一 main 校验）

## 2. agent-runner 工具注册

- [x] 2.1 `ipc-mcp-stdio.ts` 注册 `delegate(target, text, title?)` — **无 task_id 参数**，仅主群语义，写 type:'delegate' IPC
- [x] 2.2 `ipc-mcp-stdio.ts` 注册 `report_to_main(status, summary, details?, artifacts?)` — **无 target、无 task_id 参数**，写 type:'report' IPC
- [x] 2.3 工具描述里写清边界（delegate 仅主群、report_to_main 仅子群且恒发唯一主群；task_id 全由 host 管，agent 不碰）

## 3. host IPC 处理（src/ipc.ts）

- [x] 3.1 `type === 'delegate'` 分支：校验 isMain → **一群一在办任务约束**（目标群已有非终态 delegation 则拒绝）→ createDelegation 拿 task_id → host 注入 [task_id:xxx] 前缀 → 复用跨群投递 → 回写 dispatch_msg_id
- [x] 3.2 `type === 'report'` 分支：校验源群非 main → getMainGroup（0 或 >1 抛错）→ getActiveDelegationByGroup(sourceGroup) 锁 task_id → updateDelegationOnReport → 组装可读汇报消息
- [x] 3.3 **artifacts 路径白名单校验**：path.resolve 后前缀必须命中 group workspace / 项目根 / `/tmp/nanoclaw-artifacts/`（加 path.sep 防前缀绕过）+ 敏感子路径黑名单（.ssh/.aws/.config/.env）；非法路径降级为 details 纯文本备注，不记入 artifacts 字段
- [x] 3.4 汇报消息 storeMessageDirect 入主群：**host 时刻 timestamp + ipc_ 前缀 + is_from_me=false**
- [x] 3.5 **不调用 enqueueMessageCheck**（注释说明：复用 message loop 防双投喂）
- [x] 3.6 非法调用拒绝 + warn（主群调 report / 子群调 delegate / 多 main 群 / 目标群已有在办任务）
- [x] 3.7 **host 边界白名单校验 report status**（不信任 agent schema，绕过写 IPC 注入 closed/dispatched 被丢弃）
- [x] 3.8 **无在办任务的 report 直接拒绝**（不更新账本、不投主群，防越界旁路）
- [x] 3.9 **同主群 ipc_ 汇报 timestamp 严格单调递增**（nextIpcTimestamp，防 message loop 游标同毫秒漏扫）
- [x] 3.10 **拒绝 delegate 给主群自己**；delegate 发送失败 / 入库失败均回滚账本（close）+ 通知主群
- [x] 3.11 **子群一轮 query 结束自动终态兜底**（finalizeDelegationOnTurnEnd：进行态自动补 done/failed，等待态不覆盖；接入 index.ts success/error 路径）

## 4. /delegate 命令（src/commands/delegate.ts）

- [x] 4.1 `requiresMain: true`，注册进 commands/index.ts
- [x] 4.2 `/delegate status [group]` — 表格渲染账本 + 超时惰性判定（**仅 dispatched/progress** 标 ⚠️失联，不改 DB status）
- [x] 4.3 `/delegate reply <task_id> <text>` — 对占槽态（progress/blocked/question）任务续投：host 注入 [task_id:xxx] 投原 target_jid，不新建 task、不改 task_id，状态回置 progress（解 P1 question 续投）
- [x] 4.4 `/delegate retry <task_id>` — 读原 title 重派、状态回 dispatched
- [x] 4.5 `/delegate close <task_id>` — 状态置 closed，释放在办槽位
- [x] 4.6 db 层加 `replyDelegation`（续投改 progress）、`closeDelegation`（置 closed）；`getActiveDelegationByGroup` 占槽态判定含 dispatched/progress/blocked/question
- [x] 4.7 命令单测（reply 拒关闭态、close 释放槽位、reply 后能再派）

## 5. 验证

- [x] 5.1 tsc 通过
- [x] 5.2 相关单测全过（db / ipc / commands / 现有回归）
- [x] 5.3 build（tsc + agent-runner）
- [x] 5.4 合 main + 重启
- [x] 5.5 E2E：主群 `delegate` 一个真实小任务给某子群 → 子群干 → `report_to_main` 汇报 → 主群 message loop 单次收到 → `/delegate status` 看到状态 → 确认不刷屏、不双投喂

## 6. 收尾

- [x] 6.1 wrapup 复盘文档 + wiki ingest
- [x] 6.2 archive OpenSpec change
