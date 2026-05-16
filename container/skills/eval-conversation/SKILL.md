---
name: eval-conversation
description: 测评 Nine 机器人对话质量。分析 LLM 思考链路、tool call 参数/结果/性能，评估回复准确性，给出优化建议。触发词：测评、评估对话、分析会话、eval。
---

# 会话测评

对 Nine DEV 环境的 agent 对话进行全链路质量分析。

## 触发方式

用户说以下任意一种：
- "测评下最新会话"
- "分析下我跟 Nine 的最新对话"
- "评估下这个对话"（+ 提供 conversation_id）

## 执行流程

### 第 1 步：获取对话数据

从 DEV 数据库拉取完整对话记录：

```bash
# 查大杰最近的对话（按时间倒序）
ssh dev "docker exec enterprise-ai-mysql mysql -uai_user -pai_password_123 enterprise_ai_agent -e \"
  SELECT conversation_id, MIN(created_at) as start_time, MAX(created_at) as end_time, COUNT(*) as msg_count
  FROM agent_messages
  WHERE user_id = '8c39729f-2165-4197-b45f-08542f9302f5'
  AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
  GROUP BY conversation_id
  ORDER BY end_time DESC
  LIMIT 5
\"" 2>/dev/null

# 拉取指定对话的完整消息（content 取前 800 字符避免过长）
ssh dev "docker exec enterprise-ai-mysql mysql -uai_user -pai_password_123 enterprise_ai_agent -e \"
  SELECT seq, role, LEFT(content, 800) as c, created_at
  FROM agent_messages
  WHERE conversation_id = 'CONV_ID_HERE'
  ORDER BY seq ASC
\"" 2>/dev/null
```

如果消息较多，分批拉取：先拉 user + assistant 消息概览，再按需拉 tool 结果详情。

### 第 2 步：逐轮分析 Tool Call 链路

对每一轮 assistant → tool 交互，分析以下维度：

#### A. Skill 路由
- 选的 skill 对不对？有没有更合适的？
- `biz_code_locate` vs `business_logic` vs `code_analyst` — 根据问题类型判断

#### B. 参数质量
- `repo_ids` / `repo` 是否正确？有没有瞎猜不存在的仓库？
- `query` / `pattern` 是否合理？太宽还是太窄？
- `path` 格式是否正确（mothership 相对路径 vs 仓库名拼接）？
- 有没有从上一轮结果中正确提取参数？

#### C. 结果利用
- 返回了有效信息但 agent 没用上？
- 返回了接口列表但 agent 又去猜路径？
- 是否出现重复调用（同参数调两次）？

#### D. 结果格式与大小
- tool 返回内容是否过大导致 token 浪费？
- 是否有重复内容（同一结果出现两次）？
- 错误信息是否清晰可操作？

#### E. 性能
- 单次 tool call 耗时（从 created_at 差值推算）
- 总对话耗时
- 有没有超时（>15s 的调用）

### 第 3 步：评估最终回复

#### 准确性评估
- 回复中的每个事实性断言，是否有对应的 tool call 结果支撑？
- 标注哪些内容是"代码验证过的"，哪些是"LLM 推理/脑补的"
- 脑补内容是否合理？有没有编造不存在的服务/接口/函数？

#### 表达评估
- 是否用业务语言而非代码术语？
- 结构是否清晰（分步骤、标服务归属）？
- 长度是否合适？

### 第 4 步：输出评分

## 评分维度（6 维度，总分 30）

| 维度 | 满分 | 评分标准 |
|------|------|---------|
| **Skill 路由** | 5 | 选对 skill 5分，选了次优 3分，选错 1分 |
| **参数质量** | 5 | 全部正确 5分，有猜错但不影响结果 3分，严重猜错 1分 |
| **调用效率** | 5 | 无浪费 5分，1-2 轮浪费 3分，3+ 轮浪费 1分 |
| **结果利用** | 5 | 充分利用返回信息 5分，部分忽略 3分，大量忽略 1分 |
| **回复准确性** | 5 | 全部有证据 5分，少量脑补但合理 3分，大量脑补 1分 |
| **回复表达** | 5 | 业务语言+结构清晰+长度适中 5分 |

**及格线：20/30**

## 输出格式

```
## 会话测评报告

**对话ID**: xxx
**用户问题**: "xxx"
**总轮次**: X 轮 tool call + 1 轮最终回复
**总耗时**: Xs

### Tool Call 链路分析

| 轮次 | 动作 | 参数 | 结果 | 问题 |
|------|------|------|------|------|
| 1 | load_skill("xxx") | - | ✅ | - |
| 2 | search_code(...) | repo_ids 猜错 | ❌ 空 | 仓库名不存在 |
| ... | ... | ... | ... | ... |

### 回复内容审计

| 段落 | 来源 | 置信度 |
|------|------|--------|
| "入口校验 /v1/recycle/can_recycle" | tool call #5 结果 | ✅ 已验证 |
| "AI 辅助估价" | tool call #4 部分匹配 | ⚠️ 推测 |
| "仓储质检 server-ms-quality" | 无证据 | ❌ 脑补 |

### 评分

| 维度 | 得分 | 说明 |
|------|------|------|
| Skill 路由 | X/5 | ... |
| 参数质量 | X/5 | ... |
| 调用效率 | X/5 | ... |
| 结果利用 | X/5 | ... |
| 回复准确性 | X/5 | ... |
| 回复表达 | X/5 | ... |
| **总分** | **X/30** | ✅/❌ |

### 优化建议

1. [具体可操作的建议]
2. [具体可操作的建议]
```

## 注意事项

- 不要跳过数据收集直接评分，必须看完整对话
- 对话太长时分批拉取，优先看 assistant 的 tool_calls 和最终回复
- tool result 如果被截断（`LEFT(content, 800)`），需要判断是否影响分析，必要时拉完整内容
- 评分要客观，有证据支撑，不要因为回复"看起来不错"就给高分
- 优化建议要具体可操作：改哪个文件、改什么逻辑、预期效果是什么
