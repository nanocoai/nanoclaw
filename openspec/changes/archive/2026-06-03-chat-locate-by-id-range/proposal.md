## Why

现有聊天记录查询只能靠 `search_chat`（语义/关键词检索）找到大致位置，再用 `get_chat_context` 按**时间戳**展开上下文。两个场景没法覆盖：(1) 已经拿到某条消息的 **ID**（比如从飞书引用、日志、回填数据里），想直接定位并看它前后对话；(2) 想看某个群**最近倒数 N 条**或翻页式回看历史（第 N~N+M 条），现有接口全是时间戳定位，不支持按位置序号（OFFSET）。

## What Changes

- **新增 `get_message_by_id` MCP 工具**：传消息 ID + before/after，直接定位该消息并展开前后上下文（消息 ID 是 messages 表主键，全局唯一，无需传 chat_jid）
- **新增 `get_message_range` MCP 工具**：传 chat_jid + offset + limit，按时间倒序做区间查询（倒数第 offset 条起取 limit 条），用于"最近 N 条"和翻页回看
- **`src/db.ts`**：新增 `getMessageContextById(messageId, before, after)` 和 `getMessageRange(chatJid, offset, limit)` 两个纯查询函数（`getMessageById` 保持原样不动，飞书 reply-ctx 仍在用）
- **`src/ipc.ts`**：新增 `get_message_by_id`、`get_message_range` 两个 IPC 任务类型 handler
- **`container/agent-runner/src/ipc-mcp-stdio.ts`**：新增两个 MCP 工具定义 + Zod schema

## Capabilities

### New Capabilities
- `chat-precise-query`: 聊天记录精确定位查询 — 按消息 ID 定位并展开前后上下文，以及按位置序号（OFFSET）做区间/翻页查询。覆盖 DB 查询函数、IPC handler、MCP 工具三层。

### Modified Capabilities
<!-- 无：getMessageById 不改签名，现有 chat-search / get_chat_context 行为不变，不触及现有 spec 的 requirement -->

## Impact

- **代码**：`src/db.ts`（+2 函数）、`src/ipc.ts`（+2 case）、`container/agent-runner/src/ipc-mcp-stdio.ts`（+2 工具）
- **依赖**：无新依赖，无新表，无 schema 变更（纯 SQL 查询现有 messages 表）
- **兼容性**：不改 `getMessageById` 签名，飞书引用上下文（`feishu.ts:1869/1948`）不受影响；不动 `get_chat_context`，现有按时间戳展开行为不变
- **性能**：单条 SQL，messages 表已有 chat_jid + timestamp 查询模式（与 getMessageContext 一致），无额外索引需求
