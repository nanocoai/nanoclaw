## Context

聊天记录检索基础设施（change `search-chat`）已上线：messages 表存全量消息（含 bot 回复，`is_bot_message` 区分），MCP 层有 `search_chat`（双路召回）和 `get_chat_context`（按时间戳展开）。但两个精确定位场景没覆盖：

- **按 ID 定位**：`src/db.ts:381` 已有 `getMessageById(messageId)`，但只返回 `{sender_name, content}`，拿不到 timestamp/chat_jid，无法当锚点展开。且它被 `feishu.ts:1869/1948` 用于查飞书引用消息上下文，**签名不能动**。
- **按位置区间**：现有查询（`getMessageContext`/`getNewMessages`/`getMessagesSince`）全是时间戳定位，无 OFFSET 分页。

三层链路：MCP 工具（`container/agent-runner/src/ipc-mcp-stdio.ts`）→ IPC handler（`src/ipc.ts`）→ DB 查询（`src/db.ts`）。

## Goals / Non-Goals

**Goals:**
- 新增「按消息 ID 定位 + 前后展开」能力，返回结构与 `get_chat_context` 对齐
- 新增「按 OFFSET 区间查询」能力，支持"最近 N 条"和翻页回看
- 零新依赖、零 schema 变更、不破坏现有功能

**Non-Goals:**
- 不改 `getMessageById` 签名（飞书 reply-ctx 依赖）
- 不动 `get_chat_context` 的时间戳定位行为
- 不做跨会话聚合、不做全文搜索（那是 `search_chat` 的职责）
- 不加新索引（复用现有 chat_jid + timestamp 查询模式）

## Decisions

**决策 1：新增 `getMessageContextById`，不改 `getMessageById`**
- 方案：`getMessageContextById(messageId, before, after)` 先用主键查锚点行（拿到 chat_jid + timestamp），再复用 `getMessageContext` 同款 before/after 查询逻辑。
- 为什么：`getMessageById` 被飞书引用功能使用，改签名是 breaking change。新增独立函数零风险。
- 备选（否决）：给 `getMessageById` 加可选参数 → 返回类型分叉、调用方语义混乱，得不偿失。

**决策 2：`get_message_by_id` 不要求传 chat_jid**
- 为什么：messages 表 id 是 PRIMARY KEY，全局唯一，从锚点行自身就能解析出 chat_jid。少一个参数，调用方更省心，也避免传错 chat_jid 导致命中却展开为空。

**决策 3：`getMessageRange` 底层倒序分页，结果反转为正序返回**
- 方案：`SELECT * FROM (... WHERE chat_jid=? AND content非空 ORDER BY timestamp DESC LIMIT ? OFFSET ?) ORDER BY timestamp ASC`。offset=0 = 最新一条起。
- 为什么：用户想要的是"最近的"，倒序分页直觉自然；但阅读时正序（早→晚）更友好。这个"倒序取、正序展示"的模式与 `getMessageContext` 的 before 查询完全一致。

**决策 4：返回结构对齐**
- `getMessageContextById` 返回 `{before, anchor, after}`，与 `getMessageContext` 完全一致，前端/agent 复用同一展示逻辑。

**决策 5：精确定位查询包含 bot 回复，只过滤空内容**
- 方案：两个新函数都**不**按 `is_bot_message` 过滤，只过滤空内容（与 `getMessageContext` db.ts:504 行为一致）。
- 为什么：`getNewMessages`/`getMessagesSince` 过滤 bot 消息是因为它们服务于"新消息触发处理"，不该把 AI 自己的回复当新输入。但精确定位/区间回看的目的是看**完整对话**，AI 回复是对话的一部分，必须保留。

**决策 6：offset/limit 在边界层钳制**
- 方案：offset<0 钳制为 0；limit 默认 20、上限 200（与现有 `getNewMessages` limit=200 惯例一致）。钳制放在 Zod schema + IPC handler 层（DB 函数假设入参已合法）。
- 为什么：better-sqlite3 对负 OFFSET 行为未定义；超大 OFFSET/limit 会触发全表线性扫描。早钳制，DB 层保持纯粹。

## Risks / Trade-offs

- [大 OFFSET 性能] SQLite OFFSET 是线性扫描，offset 很大时变慢 → 当前单群消息量级（千~万条）无压力；真出现超大群再考虑 keyset 分页。
- [content 过滤与 OFFSET 计数] 过滤空内容消息后，offset 基于"过滤后"的序列计数 → 在 spec 里明确语义即可，对调用方透明。
- [消息 ID 来源] agent 拿到的 ID 必须是 messages 表主键（飞书 message_id 或回填 ID）→ 工具描述里写清 ID 从何而来。

## Migration Plan

- 纯增量，无 DB schema 变更，无需迁移。
- 部署：改动随容器镜像 + 主进程一起上线（MCP 工具在 container，handler/db 在主进程，两边需同步部署）。
- 回滚：删除新增工具/handler/函数即可，对存量数据无影响。

## Open Questions

- 暂无。`get_message_range` 是否需要 sender 过滤可后续按需加，本期不做。

## 测试计划

**测试分层：**

DB 层两个新函数是 SQLite I/O，但 `db.ts` 已有 `_initTestDatabase()`（内存库）+ `_closeDatabase()` 模式，可建内存 SQLite 插真数据跑真 SQL —— **零 mock、快、不 flaky**，作为主力测试手段。

- **P0（核心逻辑必测，`src/db.test.ts` 或同目录新建测试文件，用内存库）：**
  - `getMessageContextById`：ID 命中正常展开 / ID 不存在返回空 anchor / before/after 默认值 / 锚点在会话边界（before 为空、不跨会话）
  - `getMessageRange`：offset=0 取最近 N 条且正序 / 翻页取更早区间 / offset 超界返回空 / 空 chat_jid 返回空 / 空内容消息被过滤
  - 约 9~11 个用例

- **P1（IPC handler 路由，`src/ipc.test.ts` 视现有约定）：**
  - `get_message_by_id` / `get_message_range` 两个 case 正确解析参数、调对应 db 函数、写回 response、异常被 try-catch
  - 约 4 个用例

- **P2（MCP 工具 schema）：**
  - Zod schema 对必填/可选参数与默认值的校验（before/after/limit 默认值，offset 必填）
  - 约 2~3 个用例

**预估范围**：约 15~18 个用例，集中在 `src/db.ts`（主力）、`src/ipc.ts`、`ipc-mcp-stdio.ts` 三个改动点。优先把 P0 的 DB 纯查询测扎实，这是行为正确性的根。
