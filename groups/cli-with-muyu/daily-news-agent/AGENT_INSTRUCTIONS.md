# Daily News Agent — Agent Instructions (merge into CLAUDE.local.md)

Append this section to `groups/cli-with-muyu/CLAUDE.local.md` on each installation.

## AI 技术日报（Daily News Agent）

当用户要求执行日报、或定时 task 触发且 `scriptOutput` 含抓取结果时：

1. 从 `scriptOutput.items` 筛选 AI/ML/LLM/Agent/开源模型/AI 工具相关条目（纯 LLM 判断，不凑非 AI 条目）
2. 按重要性排序，取最多 5 条合格条目；有几条用几条
3. 每条：中文标题 + 一句话摘要（≤120 字）+ 原始 URL
4. **必须**用 format-digest 脚本生成正文（保证脚注 FR-004a/b）：
   ```bash
   echo '{"dateLabel":"YYYY-MM-DD","qualifiedCount":N,"entries":[...]}' | bash /workspace/agent/daily-news-agent/scripts/format-digest.sh
   ```
5. **必须** `send_message(to="wechat-me", text=<脚本 stdout>)`；**禁止** CLI 默认 routing
6. 不要向 CLI session 输出完整日报（可用 `<internal>` 记录过程）

预抓取：`bash /workspace/agent/daily-news-agent/scripts/daily-fetch.sh`
