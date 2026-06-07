## 设计

### 1. 数据模型：delegation_tasks 账本

建在 `src/db.ts` 顶部 `CREATE TABLE IF NOT EXISTS` 初始化块（NanoClaw 的建表惯例，非 Nine 的 run_migrations）：

```sql
CREATE TABLE IF NOT EXISTS delegation_tasks (
  task_id        TEXT PRIMARY KEY,        -- 派发时生成，如 dlg_<ts>_<rand>
  target_group   TEXT NOT NULL,           -- 被派活的子群 folder（如 fs_oc_xxx）
  target_jid     TEXT NOT NULL,           -- 子群 chat_jid
  title          TEXT,                    -- 任务简述（派发时主群给）
  status         TEXT NOT NULL,           -- dispatched/progress/done/blocked/failed/question/closed（timeout 是渲染显示态，不落库）
  summary        TEXT,                    -- 最近一次汇报摘要
  details        TEXT,                    -- 最近一次汇报详情
  artifacts      TEXT,                    -- JSON 数组，宿主机绝对路径
  dispatch_msg_id TEXT,                   -- 派发消息的 feishu msgId（可空）
  dispatched_at  TEXT NOT NULL,           -- ISO 时间
  last_report_at TEXT,                    -- 最近汇报时间，超时检测用
  updated_at     TEXT NOT NULL
);
```

`db.ts` 配套函数：`createDelegation()`、`updateDelegationOnReport()`、`getDelegation(taskId)`、`listDelegations(filter?)`、`getActiveDelegationByGroup(targetGroup)`（task_id 兜底反查用）。

### 2. 派发：delegate 工具（仅主群）

`ipc-mcp-stdio.ts` 注册 `delegate(target, text, title?)`：
- **不接受 task_id 参数**——task_id 完全由 host 生成，agent 不得自带（防撞车/伪造/覆盖账本）。
- 复用 `resolveTargetChatJid` 解析别名（"3号" → jid）。
- 写 IPC 文件 `type: 'delegate'`，带 `target/text/title`。host 端落账本拿 `task_id`。

host `ipc.ts` 处理 `type === 'delegate'`：
1. 校验 `isMain`（非主群调用直接拒绝 + warn）。
2. **一群一在办任务约束**：若目标群已有**占槽态**（dispatched/progress/blocked/question）delegation，拒绝新建并提示主群"该群有在办任务，用 `/delegate reply` 续投、`/delegate retry` 重派或 `/delegate close` 关闭"。保证一个子群同时只跑一个 delegation，host 用 source_group 即可唯一锁定任务。**注意：question/blocked 不是终态，主群答复要走 `/delegate reply <task_id>` 续投，不能再 `delegate` 新建（会被本约束挡住）。**
3. **先落账本**：`createDelegation()` 生成 `task_id`，status=`dispatched`。
4. 把 `task_id` 注入投递文本（host 加，不靠 agent）：消息体前缀 `[task_id:dlg_xxx]\n`，子群 agent prompt 能看到。账本同时存 task_id↔target_group 映射，不只靠文本。
5. 复用现有跨群投递逻辑 `send_message` + `storeMessageDirect`（host 时刻 timestamp、ipc_ 前缀）投到子群。
6. 回写 `dispatch_msg_id`。

> 派发先落账本再投递，保证不出现"发了活但账本没记"的悬空。

### 3. 回流：report_to_main 工具（仅子群）+ report IPC

`ipc-mcp-stdio.ts` 注册 `report_to_main(status, summary, details?, artifacts?)`：
- **不接受 target 参数**——目标恒为唯一 main 群，子群无法乱发。
- **不接受 task_id 参数**——host 用 source_group 唯一反查在办任务（依赖"一群一在办任务"约束），agent 不碰 task_id。
- 写 IPC 文件 `type: 'report'`，带 `sourceGroup`（由 IPC 目录推断，不靠 agent 自报）。

host `ipc.ts` 处理 `type === 'report'`：
1. 校验源群**非 main**（main 不该用 report_to_main）。
2. 解析唯一 main 群 jid（`getMainGroup()`：registeredGroups 中 isMain=true 的群；若 0 个或 >1 个 → 报错，不静默降级）。
3. **task_id 由 host 锁定**：用 `getActiveDelegationByGroup(sourceGroup)` 反查该群唯一非终态任务（一群一任务约束保证唯一）。若该群无在办任务，记 warn 并**拒绝该汇报**（不更新账本、不投递主群）——汇报通道只服务已派工任务，无 task 锁定的汇报视为越界，不能成为子群任意向主群发消息的旁路。
4. **artifacts 路径校验**（见第 4.5 节白名单）：合法路径记账本，非法路径降级为纯文本备注，不记入 artifacts 字段。
5. `updateDelegationOnReport()`：更新 status/summary/details/artifacts/last_report_at。
6. **投递主群**：把汇报组装成可读消息（`【汇报｜3号｜done】summary...`），`storeMessageDirect` 写主群 messages.db，**host 时刻 timestamp + ipc_ 前缀**，`is_from_me=false`、`is_bot_message=false`。
7. **不调用 `enqueueMessageCheck`** —— 交给 message loop 统一发现处理。

### 4. 限流复用 message loop（关键，防重蹈双投喂）

report 投递主群 DB 后**绝不单开 enqueue**。理由：2026-06-07 刚修的双投喂 bug 根因就是 IPC 主动 enqueue 与 message loop 并行投喂。若 report 复刻这条路径，10 个子群同时 done 会触发主群 agent 10 次 + 双投喂。

正确路径：report 消息（ipc_ 前缀，绕过 trigger）入主群 DB → message loop 下个 poll 周期扫到 → 把该周期内**所有**汇报合并成一次 context 喂给主群 agent。天然限流、自动聚合、单一投喂路径。这也是为什么汇报必须用 host 时刻 timestamp（否则被全局 lastTimestamp 跳过，复用同一修复）。

### 4.6 子群一轮结束自动终态兜底（防忘汇报）

`report_to_main` 是主动汇报主路径，但 agent 可能干完忘了调，账本卡 dispatched/progress 直到 15 分钟失联才暴露。host 在 `index.ts` 子群「一轮 query 结束」信号处调 `finalizeDelegationOnTurnEnd(sourceGroup, ok, finalReply)` 兜底：若该群仍有**进行态**任务，自动补终态（正常结束 `done`、异常结束 `failed`），并把子群本轮最终回复（`agentReplies` 拼接，截断 2000 字）写入账本 details + 投递主群的汇报消息，避免主群只收到「host 自动标记完成」却不知干了什么。仅进行态生效——等待态（blocked/question）是 agent 主动留的信号不覆盖，关闭态 `getActiveDelegationByGroup` 查不到天然跳过，故 agent 已自主汇报则不重复触发。

### 4.5 artifacts 路径白名单（防权限泄漏）

子群上报的 artifacts **不允许任意宿主机绝对路径**（否则可报 `/Users/dajay/.ssh/...` 等敏感路径，即便非恶意也是泄漏面）。host 对每个 artifact 路径 `path.resolve()` 规范化后做白名单前缀校验，前缀必须是以下之一（且加 `path.sep` 防 `/tmp/nanoclaw-artifacts-evil` 这类前缀绕过）：

1. 该子群的 group workspace：`resolveGroupFolderPath(sourceGroup)`（`groups/<folder>/`）
2. 该子群的干活项目根：`group.customCwd || NANOCLAW_DEFAULT_CWD`（子群在 nine 仓库等项目里产出的 diff/文件）
3. 约定的临时产物目录：`/tmp/nanoclaw-artifacts/`

校验逻辑：
- 命中白名单 → 记入账本 `artifacts` 字段。
- 未命中（如 `~/.ssh/id_rsa`）→ **不记入 artifacts**，降级为 details 里的纯文本备注（`[artifact 路径不合法已忽略: xxx]`），并记 warn。不抛异常中断汇报。
- 额外黑名单兜底：即使落在项目根内，命中 `.ssh` / `.aws` / `.config/` / `.env` 等敏感子路径也拒绝。

### 5. 超时/僵尸检测

不做后台定时扫（避免新增 timer 复杂度）。改为**惰性判定**：`/delegate status` 渲染时，**仅对 status ∈ {dispatched, progress}** 且 `now - last_report_at`（或无汇报则 `now - dispatched_at`）超阈值（默认 15min，可配）的任务显示 `⚠️ 失联`，但不改 DB status。

状态语义统一（codex review 拍板，P2 修订）：

| 类别 | 状态 | 占在办槽位 | 标失联 | 说明 |
|------|------|:---:|:---:|------|
| 进行态 | `dispatched` / `progress` | ✅ | ✅ | 活儿该在动，超阈值无汇报 → 显示失联 |
| 等待态 | `blocked` / `question` | ✅ | ❌ | 球不在子群侧（blocked 等人工解、question 等主群答），不算失联但仍占槽 |
| 关闭态 | `done` / `failed` / `closed` | ❌ | ❌ | 任务结束，释放槽位 |

- **占槽 ≠ 终态**：blocked/question 占槽但非终态，要靠 `/delegate reply`（续投推进，状态回 progress）、`/delegate retry`（重派回 dispatched）或 `/delegate close`（主动关闭 → closed）释放/推进。
- **失联只针对 `dispatched` / `progress`**（活儿应该在动却没动静）。
- `closed` 是主群通过 `/delegate close` 显式关闭的态，区别于子群 report 的 `done`/`failed`。report_to_main 只能设 progress/done/blocked/failed/question 五种，dispatched 由派发设、closed 由命令设。

呼应 runTask-orphan-state：agent 进程被 kill 后不会汇报，dispatched/progress 任务能在 status 里暴露失联。

### 6. /delegate 命令（仅主群）

`src/commands/delegate.ts`，`requiresMain: true`：
- `/delegate status [group]`：表格列出账本（task_id 短码、target、status、最后汇报时间、失联标记、summary 截断）。
- `/delegate reply <task_id> <text>`：对**占槽态**（progress/blocked/question）的现有任务追加续投。host 复用派发投递逻辑，把 `[task_id:xxx]\n<text>` 投到账本里的原 target_jid，**不新建 task、不改 task_id**。若原状态是 question/blocked，续投后状态回置 `progress`（主群已答复，球回子群）。解 P1：question/blocked 占槽，主群没法再 `delegate`，必须用 reply 续投推进。
- `/delegate retry <task_id>`：读账本原 title 重新 delegate 到原 group，状态回 dispatched。
- `/delegate close <task_id>`：主群主动关闭任务，状态置 `closed`，释放在办槽位（用于放弃卡死/不再需要的任务）。
- 聚合摘要不单设命令——主群 agent 需要时调 `listDelegations` 读账本自行总结。

### 7. 安全边界（明确不做）

- 子群**不能** `send_message` 到任意群（授权逻辑 `ipc.ts:223` 保持不变，不放开）。子群对外只有 `report_to_main` 一条受限通道，且目标恒为唯一 main。
- 主群可 `delegate` / `send_message` 到任意群（现状）。
- 不引入任务依赖图（A 群完成才能派 B 群）——第一版账本平铺，复杂编排留后续迭代。
- 不做多轮"问答"自动流转——`status=question` 仅在账本标记 + 汇报进主群让主群 agent 看到，主群再人工/agent 决策追加 delegate。问答子流程留第二版。

### 8. 状态机

```
dispatched ──report progress──► progress ──┐
    │                              │        ├─► done    (关闭态，释放槽位)
    │                              ├────────┼─► failed  (关闭态，释放槽位)
    └──report done直接完成─────────┘        ├─► blocked  (等待态，占槽)
                                            └─► question (等待态，占槽)

blocked/question ──/delegate reply <task_id> <text>──► progress  (主群续投，球回子群)
任意占槽态        ──/delegate retry <task_id>────────► dispatched (重派)
任意占槽态        ──/delegate close <task_id>────────► closed     (主群关闭，释放槽位)
dispatched/progress + 超时 ──惰性判定──► ⚠️失联(显示态，不改 DB)
```

## 决策记录（codex review 拍板）

1. **独立 `delegate` 工具**：✅ 认可，不污染 `send_message`。
2. **task_id 完全 host 生成**：✅ `delegate` 与 `report_to_main` 都**删除 task_id 参数**，agent 不碰 task_id。配套"一群一在办任务"约束，host 用 source_group 唯一锁定任务。retry 用旧账本 task_id。task_id↔group 映射存账本，不只靠文本前缀。
3. **task_id `[task_id:xxx]` 前缀**：✅ 接受，但 host 注入、host 解析，账本同存映射。
4. **artifacts 路径白名单**：✅ 不允许任意宿主机路径，限 group workspace / 项目根 / `/tmp/nanoclaw-artifacts/`，host 做 resolve 校验 + 敏感子路径黑名单，非法降级纯文本。
5. **超时 15min 惰性判定**：✅ 不开后台 timer；失联只针对 dispatched/progress。
6. **状态语义统一（P2 修订）**：✅ 三分类——进行态 dispatched/progress（占槽+标失联）；等待态 blocked/question（占槽+不标失联）；关闭态 done/failed/closed（释放槽位）。blocked 不是终态，纠正先前"done/failed/blocked 为终态"的措辞。
7. **question/blocked 续投走 `/delegate reply`（P1 修订）**：✅ 因占槽态挡住新 `delegate`，主群答复 question/blocked 必须用 `/delegate reply <task_id> <text>` 显式续投（不新建 task、不改 task_id，host 注入前缀投原子群，状态回 progress）。这是人工显式续投，不是自动问答流转，符合第一版"不做自动流转"边界。配套加 `/delegate close` 释放卡死任务槽位。
8. **第一版范围**：✅ 先窄后宽，问答**自动**流转、任务依赖图不做，留迭代（`/delegate reply` 是人工续投，不算自动流转）。
