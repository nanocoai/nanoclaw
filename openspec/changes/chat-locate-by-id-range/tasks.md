## 1. DB 查询层 (src/db.ts)

- [ ] 1.1 新增 `getMessageContextById(messageId, before=5, after=5)`：锚点用**新的** `SELECT id, chat_jid, sender_name, content, timestamp, is_from_me FROM messages WHERE id=?`（不复用只返回 sender_name/content 的旧 getMessageById），命中后用 chat_jid+timestamp 复用 getMessageContext 同款 before/after 查询逻辑，返回 `{before, anchor, after}`；ID 不存在返回 `{before:[], anchor:null, after:[]}`。**不按 is_bot_message 过滤**，只过滤空内容
- [ ] 1.2 新增 `getMessageRange(chatJid, offset, limit)`：`ORDER BY timestamp DESC LIMIT ? OFFSET ?` 取片段后反转为正序返回，过滤空内容消息，**不按 is_bot_message 过滤**（DB 层假设 offset/limit 已合法）
- [ ] 1.3 确认 `getMessageById` 保持原样不动（飞书 reply-ctx 依赖）

## 2. DB 层单元测试 (P0)

- [ ] 2.1 用 `_initTestDatabase()` 建内存库 + 插测试消息夹具
- [ ] 2.2 `getMessageContextById` 测试：ID 命中正常展开 / ID 不存在 / 默认 before-after / 锚点在会话边界 before 为空 / 不跨会话
- [ ] 2.3 `getMessageRange` 测试：offset=0 取最近 N 且正序 / 翻页取更早区间 / offset 超界返回空 / 空 chat_jid 返回空 / 空内容消息不计入 offset 序列 / 含 bot 消息
- [ ] 2.4 `getMessageContextById` 含 bot 消息测试：锚点前后的 bot 回复正常出现在 before/after

## 3. IPC handler (src/ipc.ts)

- [ ] 3.1 新增 `get_message_by_id` case：解析 messageId/before/after，调 getMessageContextById，写 response，try-catch 包裹
- [ ] 3.2 新增 `get_message_range` case：解析 chat_jid/offset/limit，调 getMessageRange，写 response，try-catch 包裹
- [ ] 3.3 IPC handler 测试 (P1)：两个 case 参数解析 + 路由 + 异常处理

## 4. MCP 工具层 (container/agent-runner/src/ipc-mcp-stdio.ts)

- [ ] 4.1 新增 `get_message_by_id` 工具：Zod schema（message_id: string, before/after: number 可选默认 5），writeIpcFile + waitForResponse
- [ ] 4.2 新增 `get_message_range` 工具：Zod schema（chat_jid: string, offset: number 默认 0, limit: number 可选默认 20），在 schema/handler 层钳制 offset>=0、limit<=200，writeIpcFile + waitForResponse
- [ ] 4.3 工具描述写清：message_id 来源（messages 主键）、offset 倒序语义（0=最新）
- [ ] 4.4 Zod schema 校验测试 (P2)

## 5. 集成验证

- [ ] 5.1 `npm run build`（tsc 编译通过）
- [ ] 5.2 跑全部新增单测通过
- [ ] 5.3 端到端：容器内 agent 实际调用两个工具，验证返回结构正确（用大杰账号在飞书可见）
