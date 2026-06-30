import fs from 'node:fs';
import path from 'node:path';

export const DAILY_NEWS_SCRIPT = 'bash /workspace/agent/daily-news-agent/scripts/daily-fetch.sh';

/** Embedded prompt from specs/001-daily-news-agent/contracts/task-prompt.md */
export const EMBEDDED_TASK_PROMPT = `你是 AI 技术日报助手。本次任务的 scriptOutput 包含 HN 与 RSS 抓取结果。

步骤：
1. 从 scriptOutput.items 中筛选 AI/ML/LLM/Agent/开源模型/AI 工具 相关条目（纯 LLM 判断，不凑非 AI 条目）
2. 按重要性排序，取最多 5 条合格条目；有几条用几条
3. 每条输出：中文标题 + 一句话摘要（≤120 字）+ 原始 URL
4. 组装正文**必须**调用 format-digest 脚本（禁止手写拼接以免遗漏脚注）：
   echo '{"dateLabel":"YYYY-MM-DD","qualifiedCount":N,"entries":[{"rank":1,"title":"...","summary":"...","url":"..."}]}' | bash /workspace/agent/daily-news-agent/scripts/format-digest.sh
   将 stdout 作为 send_message 的 text
5. 若合格条目数 N 满足 0 ≤ N < 5，正文末尾必须追加一行：
   今日仅 N 条合格条目 (候选池 < 5)
6. 若 N = 5，不得追加上述脚注
7. 若 N = 0，发送简短「今日无 notable AI 热点」并可含 N=0 脚注
8. 必须调用 send_message(to="wechat-me", text=...) 推送；禁止依赖 CLI 默认 routing
9. 不要向当前 CLI session 输出完整日报（可用 <internal> 记录过程）`;

function extractPromptBlock(markdown: string): string {
  const match = markdown.match(/```\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error('task-prompt.md: prompt code block not found');
  }
  return match[1].trim();
}

export function resolveTaskPrompt(nanoclawRoot: string): string {
  const candidates = [
    process.env.DAILY_NEWS_TASK_PROMPT_PATH,
    path.resolve(nanoclawRoot, '../../../specs/001-daily-news-agent/contracts/task-prompt.md'),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return extractPromptBlock(fs.readFileSync(candidate, 'utf8'));
    }
  }

  return EMBEDDED_TASK_PROMPT;
}
