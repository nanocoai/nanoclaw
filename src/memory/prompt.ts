/**
 * 记忆 Prompt 模板 — 从 Nine structured/prompt.py 翻译
 *
 * 包含 MEMORY_UPDATE_PROMPT + formatMemoryForInjection + formatConversationForUpdate
 */
import { getMemoryConfig } from './config.js';

// LLM 记忆更新提示词
export const MEMORY_UPDATE_PROMPT = `你是一个记忆管理系统。你的任务是分析对话内容，更新用户的记忆档案。

**所有输出内容必须使用中文**，技术术语和专有名词可保留英文原文。

当前记忆状态：
<current_memory>
{current_memory}
</current_memory>

需要处理的新对话：
<conversation>
{conversation}
</conversation>

处理步骤：
1. 分析对话中关于用户的重要信息
2. 提取具体的事实、偏好和上下文（数字、名称、技术栈等细节）
3. 按照以下规范更新各记忆模块

记忆模块规范：

**用户概况**（当前状态 - 简洁摘要）：
- workContext：职业角色、公司、核心项目、主要技术栈（2-3 句）
  示例：核心贡献者，项目名称及指标（16k+ stars），技术栈
- personalContext：语言能力、沟通偏好、主要兴趣（1-2 句）
  示例：双语能力、专业领域、兴趣方向
- topOfMind：多个并行关注点和优先事项（3-5 句，详细段落）
  示例：主线项目工作、并行技术调研、持续学习/跟踪
  包含：正在实施的工作、排查中的问题、市场/调研兴趣
  注意：这里记录多个并行关注点，不只是单一任务

**历史记录**（时间线上下文 - 详细段落）：
- recentMonths：近期活动详细总结（4-6 句或 1-2 段）
  时间范围：最近 1-3 个月
  包含：探索的技术、参与的项目、解决的问题、展现的兴趣
- earlierContext：较早的重要模式（3-5 句或 1 段）
  时间范围：3-12 个月前
  包含：过往项目、学习历程、已建立的模式
- longTermBackground：持久的背景和基础上下文（2-4 句）
  时间范围：全局/基础性信息
  包含：核心专长、长期兴趣、基本工作风格

**事实提取**：
- 只提取未来交互中会复用的信息，宁可少记，不要把流水账写进长期记忆
- 提取具体、可量化的细节（如 "16k+ GitHub stars"、"200+ datasets"）
- 包含专有名词（公司名、项目名、技术名称）
- 保留技术术语和版本号
- 分类：
  * preference：用户明确偏好的架构、流程、风格、禁忌、取舍。长期有效，不按时间自然过期
  * knowledge：长期有效、可复用的技术结论、架构事实、踩坑经验、故障根因和解决原则
  * context：阶段性背景和当前状态，例如正在处理的 PR、临时环境状态、等待确认事项。只有对接下来几轮有用才记录
  * behavior：用户稳定反复出现的工作模式或沟通习惯。必须是可复用行为模式，不是某次任务进度
  * goal：用户明确尚未完成的目标、计划或项目愿景。已完成、已合并、已验证通过、已放弃的事项不能继续写 goal
- 置信度：
  * 0.9-1.0：明确陈述（"我做 X"、"我的角色是 Y"）
  * 0.7-0.8：从行为/讨论中强推断
  * 0.5-0.6：推断的模式（谨慎使用，仅限明确模式）
  * context 通常不超过 0.8，除非它是未来几轮必须使用的明确状态

**归类原则**：
- workContext：当前工作、活跃项目、主要技术栈
- personalContext：语言、性格、工作外的兴趣
- topOfMind：用户近期关注的多个优先事项（更新最频繁）
  应包含 3-5 个并行主题：主线工作、副线探索、学习/跟踪兴趣
- recentMonths：近期技术探索和工作的详细记录
- earlierContext：较早但仍相关的交互模式
- longTermBackground：不变的基础性用户信息

**多语言内容**：
- 专有名词和公司名保留原始语言
- 技术术语保留原始形式（DeepSeek、LangGraph 等）
- 在 personalContext 中注明语言能力

输出格式（JSON）：
{{
  "user": {{
    "workContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "personalContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "topOfMind": {{ "summary": "...", "shouldUpdate": true/false }}
  }},
  "history": {{
    "recentMonths": {{ "summary": "...", "shouldUpdate": true/false }},
    "earlierContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "longTermBackground": {{ "summary": "...", "shouldUpdate": true/false }}
  }},
  "newFacts": [
    {{ "content": "...", "category": "preference|knowledge|context|behavior|goal", "confidence": 0.0-1.0 }}
  ],
  "factsToRemove": ["fact_id_1", "fact_id_2"]
}}

重要规则：
- 仅在有实质新信息时设置 shouldUpdate=true
- 遵循长度规范：workContext/personalContext 简洁（1-3 句），topOfMind 和 history 部分详细（段落）
- 事实中包含具体指标、版本号和专有名词，但不要为了具体而记录短期流水账
- 仅添加明确陈述（0.9+）或强推断（0.7+）的事实
- 删除被新信息矛盾的旧事实
- 更新 topOfMind 时，整合新关注点并移除已完成/放弃的项目，保持 3-5 个活跃主题
- history 部分按时间线整合新信息
- 保持技术准确性 — 保留技术、公司、项目的准确名称
- 聚焦于对未来交互和个性化有用的信息
- 重要：不要记录文件上传事件。上传文件是会话级的临时资源，后续会话无法访问，记录上传事件会导致混淆。
- 重要：不要记录 PR 号、commit hash、测试通过、build 结果、当前 PID、当前分支脏项、一次性部署状态、临时文件路径。
- 重要：不要记录“某服务由 launchctl/systemd/docker 管理”这类普通运行时状态，除非用户明确把它上升为长期操作原则。
- 重要：不要记录 AI 自己刚完成了什么、刚查了什么、刚汇报了什么；这类内容只属于当前对话。
- 例外：如果 PR、日志或测试背后沉淀出可复用故障根因、架构原则、操作禁忌，只记录那条原则，不记录流水账。

只返回合法 JSON，不要解释或 markdown。`;

/**
 * token 估算：字符数 / 4（不引入 tiktoken 依赖）
 */
function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

interface MemorySection {
  summary?: string;
  updatedAt?: string;
}

export interface MemoryData {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  history?: Record<string, any>;
  facts?: Array<{
    id?: string;
    content?: string;
    category?: string;
    confidence?: number;
  }>;
}

/**
 * 将记忆数据格式化为 system prompt 注入文本
 */
export function formatMemoryForInjection(
  memoryData: MemoryData,
  maxTokens?: number,
): string {
  if (!memoryData) return '';
  const config = getMemoryConfig();
  const limit = maxTokens ?? config.maxInjectionTokens;

  const sections: string[] = [];

  // User Context
  const user = memoryData.user;
  if (user) {
    const lines: string[] = [];
    const work = user.workContext;
    if (work?.summary) lines.push(`工作: ${work.summary}`);
    const personal = user.personalContext;
    if (personal?.summary) lines.push(`个人: ${personal.summary}`);
    const topOfMind = user.topOfMind;
    if (topOfMind?.summary) lines.push(`当前关注: ${topOfMind.summary}`);
    if (lines.length > 0) {
      sections.push('用户概况:\n' + lines.map((l) => `- ${l}`).join('\n'));
    }
  }

  // History
  const history = memoryData.history;
  if (history) {
    const lines: string[] = [];
    const recent = history.recentMonths;
    if (recent?.summary) lines.push(`近期: ${recent.summary}`);
    const earlier = history.earlierContext;
    if (earlier?.summary) lines.push(`较早: ${earlier.summary}`);
    if (lines.length > 0) {
      sections.push('历史记录:\n' + lines.map((l) => `- ${l}`).join('\n'));
    }
  }

  // 事实（按置信度降序，在 token 预算内填充）
  const facts = memoryData.facts;
  if (Array.isArray(facts) && facts.length > 0) {
    const ranked = facts
      .filter((f) => f && typeof f.content === 'string' && f.content.trim())
      .sort(
        (a, b) => clampConfidence(b.confidence) - clampConfidence(a.confidence),
      );

    const baseText = sections.join('\n\n');
    const baseTokens = baseText ? countTokens(baseText) : 0;
    const factsHeader = '事实:\n';
    const separatorTokens = baseText
      ? countTokens('\n\n' + factsHeader)
      : countTokens(factsHeader);
    let runningTokens = baseTokens + separatorTokens;

    const factLines: string[] = [];
    for (const fact of ranked) {
      const content = fact.content!.trim();
      const category = (fact.category || 'context').trim() || 'context';
      const confidence = clampConfidence(fact.confidence);
      const line = `- [${category} | ${confidence.toFixed(2)}] ${content}`;

      const lineText = factLines.length > 0 ? '\n' + line : line;
      const lineTokens = countTokens(lineText);

      if (runningTokens + lineTokens <= limit) {
        factLines.push(line);
        runningTokens += lineTokens;
      } else {
        break;
      }
    }

    if (factLines.length > 0) {
      sections.push('事实:\n' + factLines.join('\n'));
    }
  }

  if (sections.length === 0) return '';

  let result = sections.join('\n\n');

  // 最终 token 检查
  const tokenCount = countTokens(result);
  if (tokenCount > limit) {
    const charPerToken = result.length / tokenCount;
    const targetChars = Math.floor(limit * charPerToken * 0.95);
    result = result.slice(0, targetChars) + '\n...';
  }

  return result;
}

export interface ConversationMessage {
  content: string;
  sender_name?: string;
  is_bot_message?: boolean;
  is_from_me?: boolean;
}

/**
 * 将对话消息格式化为记忆更新 prompt 的输入。
 * 遵循 R5.3 消息字段映射。
 */
export function formatConversationForUpdate(
  messages: ConversationMessage[],
): string {
  const lines: string[] = [];

  for (const msg of messages) {
    let content =
      typeof msg.content === 'string' ? msg.content : String(msg.content);

    // 清除上传文件标签
    content = content
      .replace(/<uploaded_files>[\s\S]*?<\/uploaded_files>\n*/g, '')
      .trim();
    if (!content) continue;

    // 截断过长消息
    if (content.length > 1000) {
      content = content.slice(0, 1000) + '...';
    }

    // R5.3: is_bot_message === true 或 is_from_me === true → Assistant
    if (msg.is_bot_message || msg.is_from_me) {
      lines.push(`Assistant: ${content}`);
    } else {
      const name = msg.sender_name || 'User';
      lines.push(`User (${name}): ${content}`);
    }
  }

  return lines.join('\n\n');
}
