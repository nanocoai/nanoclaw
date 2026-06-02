## ADDED Requirements

### Requirement: 按消息 ID 定位并展开上下文

系统 SHALL 提供 `get_message_by_id` 能力，给定一个消息 ID，定位该消息并返回其前后各 N 条上下文。消息 ID 是 messages 表主键，全局唯一，因此调用方 MUST NOT 需要额外提供 chat_jid——系统 SHALL 从锚点消息自身解析出所属会话，仅在该会话内展开上下文。

返回结构 SHALL 为 `{ before: Message[], anchor: Message | null, after: Message[] }`，与现有 `get_chat_context` 保持一致，便于复用展示逻辑。展开 MUST 过滤空内容消息（`content != '' AND content IS NOT NULL`），与 `getMessageContext` 行为对齐。该能力 SHALL 包含 bot 回复消息（不按 `is_bot_message` 过滤），与 `getMessageContext` 一致——精确定位的目的是回看完整对话，AI 的回复是对话的一部分。

#### Scenario: ID 命中，正常展开

- **WHEN** 调用方传入存在的消息 ID，before=3、after=3
- **THEN** 系统返回该消息作为 anchor，并返回同一 chat_jid 下、按时间排序的前 3 条和后 3 条消息

#### Scenario: ID 不存在

- **WHEN** 调用方传入一个不存在的消息 ID
- **THEN** 系统返回 `{ before: [], anchor: null, after: [] }`，不抛异常

#### Scenario: before/after 使用默认值

- **WHEN** 调用方只传消息 ID，不传 before/after
- **THEN** 系统按默认值（before=5、after=5）展开上下文

#### Scenario: 锚点位于会话边界

- **WHEN** 命中的消息是该会话最早的一条，before=5
- **THEN** anchor 正常返回，before 为空数组（不报错、不跨会话取其他群消息）

#### Scenario: 上下文包含 bot 回复

- **WHEN** 锚点消息前后存在 bot 回复消息（is_bot_message=1）
- **THEN** 这些 bot 回复正常出现在 before/after 中，不被过滤掉

### Requirement: 按位置区间（OFFSET）查询会话消息

系统 SHALL 提供 `get_message_range` 能力，给定 chat_jid、offset、limit，按时间**倒序**返回该会话的一段消息：跳过最新的 offset 条，再取 limit 条。其中 offset=0 表示从最新一条开始。该能力用于"最近 N 条"回看与翻页式浏览历史，MUST NOT 依赖任何时间戳输入。

返回的消息列表 SHALL 按时间**正序**排列（最早的在前），方便阅读，即便底层查询用倒序分页。查询 MUST 限定在指定 chat_jid，且过滤空内容消息，并包含 bot 回复消息（与按 ID 定位一致）。

参数约束：系统 MUST 将 offset 钳制为非负（offset<0 视为 0），并 MUST 对 limit 设上限（默认 20，上限 200，超出则取上限），防止超大 OFFSET/limit 引发全表线性扫描。offset 与 limit 的计数 SHALL 基于"过滤空内容后"的消息序列——这是对调用方透明的稳定语义。

#### Scenario: 取最近 N 条

- **WHEN** 调用方传 chat_jid、offset=0、limit=20
- **THEN** 系统返回该会话最新的 20 条消息，按时间正序排列（最早的在前）

#### Scenario: 翻页取更早的区间

- **WHEN** 调用方传 offset=20、limit=20
- **THEN** 系统跳过最新 20 条，返回再往前的 20 条（第 21~40 新的消息）

#### Scenario: offset 超出总消息数

- **WHEN** offset 大于该会话的消息总数
- **THEN** 系统返回空数组，不抛异常

#### Scenario: chat_jid 不存在

- **WHEN** 调用方传入一个没有任何消息的 chat_jid
- **THEN** 系统返回空数组

#### Scenario: offset 为负被钳制

- **WHEN** 调用方传 offset=-5、limit=10
- **THEN** 系统按 offset=0 处理，返回最近 10 条

#### Scenario: limit 超过上限被钳制

- **WHEN** 调用方传 limit=10000
- **THEN** 系统按上限 200 返回，不引发超大扫描

#### Scenario: 空内容消息不计入区间序列

- **WHEN** 会话中夹杂若干空内容消息，调用方传 offset=0、limit=5
- **THEN** 返回的 5 条均为非空消息，空内容消息既不占 offset 计数也不出现在结果中
