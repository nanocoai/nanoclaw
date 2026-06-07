## Why

主群（main group）当前能通过 `send_message(target)` 向任意子群派活（跨群投递），但这是**单向喇叭**：子群干完活只能把回复留在自己群里，无法主动汇报回主群。主群要知道子群干到哪、干成没有，只能手动 `sqlite3` 翻每个子群的 `messages.db` + `grep` 日志——带外偷看，不可扩展。指挥 2-3 个群勉强，指挥 10 个群必废。

授权逻辑（`ipc.ts:223` `isMain || 目标群==源群`）也明确挡死了子群→主群的回发。要做"主群指挥、多群协作"的闭环，缺的是一条**安全的回流通道**和一本**派工账本**。

本提案落地 Commander 协议第一版：主群派活、子群回报、所有任务上账本。明确不放开"通用子群跨群发送"权限（防消息风暴和权限穿透），只新增受限的专用汇报通道。

## What Changes

- **新增 `delegate` MCP 工具（仅主群可用）**：派活给指定子群，签名 `delegate(target, text, title?)`，**不接受 task_id 参数**（task_id 完全由 host 生成）。先落账本拿到 `task_id`，再由 host 把 `task_id` 注入消息投递给子群。区别于 `send_message`（普通跨群闲聊），`delegate` 是带账本的"派工"语义。host 强制**一群一在办任务**：目标子群已有占槽态（dispatched/progress/blocked/question）delegation 则拒绝（主群答复/推进改走 `/delegate reply`、`retry` 或 `close`）。
- **新增 `report_to_main` MCP 工具（仅子群可用）**：子群向**唯一主群**汇报，签名 `report_to_main(status, summary, details?, artifacts?)`，**不接受 target、不接受 task_id 参数**。payload 固定 `status` / `summary` / `details?` / `artifacts?`，`status` 只允许 `progress` / `done` / `blocked` / `failed` / `question`。task_id 由 host 用 source_group 锁定。
- **新增 IPC type `report`**：host 处理 `report` IPC，校验源群非 main、目标强制为唯一 main 群，落账本 + 投递汇报消息到主群 `messages.db`。
- **回流复用 message loop**：汇报消息入主群 DB 时用 **host 入库时刻** timestamp、`ipc_` 前缀绕过 trigger，**不单开 `enqueueMessageCheck`**。交给现有 message loop 统一扫，天然把一个 poll 周期内的多条汇报合并成一次 context，自动限流防刷屏（复用 2026-06-07 删双投喂修复后的统一路径，避免重蹈覆辙）。
- **新增 `delegation_tasks` 派工账本表**：记录 `task_id` / `target_group` / `status` / `summary` / `dispatched_at` / `last_report_at` / `dispatch_msg_id`。派活落一行，汇报更新一行。
- **`task_id` 完全 host 管**：agent 既不传也不回传 task_id。派发时 host 生成并维护 `target_group → task_id` 映射；子群 `report_to_main` 时 host 用 `source_group` 反查唯一占槽态任务锁定 task_id（依赖"一群一在办任务"约束保证唯一）。防撞车/伪造/覆盖账本。
- **新增 `/delegate` 主群命令**：`/delegate status`（列账本当前状态）、`/delegate reply <task_id> <text>`（对 progress/blocked/question 任务续投，解 question 闭环——因占槽态挡住新 `delegate`，主群答复必须走 reply 显式续投，不新建 task、不改 task_id，状态回 progress）、`/delegate retry <task_id>`（重派）、`/delegate close <task_id>`（主动关闭置 closed、释放槽位）。聚合摘要由主群 agent 读账本自行生成，不单设命令。
- **超时/僵尸检测**：账本带 `last_report_at`，`/delegate status` **仅对 dispatched/progress** 标出"派了活但超阈值无汇报"的失联任务（done/failed/blocked/question 不标），呼应 `runTask-orphan-state` 坑。

## Capabilities

### New Capabilities
- `commander-delegation`: 主群派工 — `delegate` 工具落账本 + 注入 task_id + 投递；`delegation_tasks` 表生命周期；`/delegate` 命令族。
- `commander-report-channel`: 子群→主群受限回流 — `report_to_main` 工具 + `report` IPC 类型 + host 校验（源非 main、目标唯一 main）+ 复用 message loop 限流投递。

### Modified Capabilities
- （无现有 spec 需修改；跨群通信此前未 spec 化，本提案首次为 Commander 流程建 spec）

## Impact

- **代码**：
  - `container/agent-runner/src/ipc-mcp-stdio.ts`：注册 `delegate`（主群）、`report_to_main`（子群）两个工具，写对应 IPC 文件。
  - `src/ipc.ts`：新增 `type === 'report'` 分支（校验 + 落账本 + 投递主群）；`delegate` 派发分支（落账本 + 注入 task_id）。
  - `src/db.ts`：新增 `delegation_tasks` 表 DDL（建在顶部 `CREATE TABLE IF NOT EXISTS` 初始化块，NanoClaw 建表惯例，非 Nine 的 `run_migrations()`）+ 增删改查函数。
  - `src/commands/`：新增 `delegate.ts` 命令（`requiresMain: true`）。
- **数据**：新增 `delegation_tasks` 表（messages.db 同库）。
- **安全边界**：子群只能 `report_to_main`，不能 `send_message` 到任意群（授权逻辑不放开）；主群可派活给任意群。
- **API**：现有 `send_message(target)` 行为不变；`delegate` 是新增的派工入口。
- **artifacts 传递**：传宿主机绝对路径（NanoClaw 全在本机同一文件系统），主群直接读，不走飞书云盘。**但路径受白名单约束**（防权限泄漏）：host 对每个 artifact 做 `path.resolve` 后校验前缀必须命中 group workspace / 子群项目根 / `/tmp/nanoclaw-artifacts/`（加 `path.sep` 防前缀绕过）+ 敏感子路径黑名单（`.ssh`/`.aws`/`.config/`/`.env`）；非法路径降级为纯文本备注，不记入 artifacts 字段。
