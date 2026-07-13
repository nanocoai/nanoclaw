---
name: draftbook
description: NanoClaw 全局任务草稿本。用户说“保存草稿、记到草稿、打开草稿、查看草稿、继续上次方案、归档草稿”时使用；长任务出现关键方案转折或需要跨会话/跨群接力时也应使用。
allowed-tools: Bash, Read, Edit, Write
---

# 任务草稿本

草稿本位于 NanoClaw 全局运行目录 `groups/global/draftbook/`，每个任务一份 Markdown。它保存动态方案和过程结论，不替代 task-ledger（正式任务状态）或 team_wiki（稳定知识）。

## 定位文件

操作任何草稿前，先调用同目录的定位工具，禁止凭记忆猜路径：

```bash
DRAFTBOOK_TOOL="${CODEX_HOME:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/skills/draftbook/draftbook.mjs"
node "$DRAFTBOOK_TOOL" locate --group "$NANOCLAW_GROUP_FOLDER" --json
```

定位优先级固定为：

1. 用户明确给出的 draft ID、任务名或 task ID；
2. 当前群通过 `activate` 绑定的草稿；
3. 当前 task-ledger ID 对应的草稿；
4. 当前群唯一拥有的活跃草稿。

零匹配时，只有用户明确启动了新任务才创建；多匹配时列出候选让用户选择。禁止猜测，禁止为同一任务创建日期版副本。

常用命令：

```bash
node "$DRAFTBOOK_TOOL" list --json
node "$DRAFTBOOK_TOOL" locate --query "<任务名或 ID>" --json
node "$DRAFTBOOK_TOOL" locate --task-id "<tl_xxx>" --json
node "$DRAFTBOOK_TOOL" create --id "<slug>" --title "<标题>" --project "<项目>" --task-id "<可选>" --json
node "$DRAFTBOOK_TOOL" activate "<draft-id>" --group "$NANOCLAW_GROUP_FOLDER"
node "$DRAFTBOOK_TOOL" archive "<draft-id>" --json
```

## 保存草稿

1. 运行 `locate` 获得唯一文件路径。
2. 先读完整文件，确认当前 revision 和现有结论。
3. 用 Edit 更新对应区块：
   - 新结论覆盖 `当前结论`，旧态及推翻证据追加到 `过程记录`。
   - 未证实事项进入 `待确认`，不得写成确定结论。
   - 可执行动作进入 `下一步`，最多五项。
   - 被否决方案进入 `已否决方案`，写明重新考虑条件。
4. 更新 frontmatter 的 `updated_at` 和 `revision`。
5. 再读修改区块，确认写入的是定位到的同一文件。

不要复制完整聊天、长日志或内部思维过程；只保存可以帮助后续继续工作的证据、判断和决策变化。不得保存密码、API Key、OAuth token 或私钥。

## 读取与继续

用户说“继续上次方案”时，先定位并读取 `当前结论、待确认、下一步`。需要追溯理由时再读 `过程记录` 和 `已否决方案`，不要默认把全文塞进上下文。

## 与工作流联动

- kickoff：创建或激活草稿，写目标与边界。
- implement：关键方案变化、失败假设和验证结果写回草稿。
- wrapup：正式决策回写 task-ledger，稳定知识进入 team_wiki；草稿再归档。
