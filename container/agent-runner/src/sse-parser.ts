/**
 * SSE (Server-Sent Events) 解析器 — 纯函数模块
 *
 * 解析 Anthropic Messages API 的 SSE 响应流，映射为 ContainerOutput。
 * 所有函数无副作用，可直接单元测试。
 */

// ---- SSE 事件类型 ----

export type SseEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'ping'
  | 'error';

export interface SseEvent {
  type: SseEventType;
  data: unknown;
}

/** message_start 事件的 data 结构 */
export interface MessageStartData {
  type: 'message_start';
  message: {
    id: string;
    model: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/** content_block_start 事件的 data 结构 */
export interface ContentBlockStartData {
  type: 'content_block_start';
  index: number;
  content_block: {
    type: 'text' | 'tool_use';
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
}

/** content_block_delta 事件的 data 结构 */
export interface ContentBlockDeltaData {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
  };
}

/** message_delta 事件的 data 结构 */
export interface MessageDeltaData {
  type: 'message_delta';
  delta: {
    stop_reason: string;
  };
  usage: {
    output_tokens: number;
  };
}

// ---- Block 累积器 ----

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  inputJson: string;
}

export type ContentBlock = TextBlock | ToolUseBlock;

// ---- Message 累积器 ----

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface MessageAccumulator {
  model: string;
  messageId: string;
  blocks: Map<number, ContentBlock>;
  usage: UsageStats;
  stopReason: string;
  done: boolean;
  error?: string;
}

export function createMessageAccumulator(): MessageAccumulator {
  return {
    model: '',
    messageId: '',
    blocks: new Map(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    stopReason: '',
    done: false,
  };
}

// ---- 纯函数：SSE 行解析 ----

/**
 * 解析 SSE 原始行 → { event, data }
 *
 * SSE 格式：
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 *
 * 支持多行 data（用 \n 分隔的多个 data: 行）。
 * 返回 null 表示非 SSE 数据行。
 */
export function parseSseLines(lines: string[]): { event: string; data: string } | null {
  let event = '';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      event = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice(6));
    } else if (line === 'data:') {
      dataLines.push('');
    }
  }

  if (!event && dataLines.length === 0) return null;
  return { event: event || 'message', data: dataLines.join('\n') };
}

/**
 * 解析单条 SSE 事件 → 结构化 SseEvent
 * 对畸形输入宽容：返回 null
 */
export function parseSseEvent(eventType: string, dataStr: string): SseEvent | null {
  const type = eventType as SseEventType;

  // ping 不需要 data
  if (type === 'ping') {
    return { type, data: null };
  }

  // error 事件
  if (type === 'error') {
    try {
      return { type, data: JSON.parse(dataStr) };
    } catch {
      return { type, data: { message: dataStr } };
    }
  }

  // 其他事件：解析 JSON data
  if (!dataStr.trim()) return null;
  try {
    const data = JSON.parse(dataStr);
    // 验证 type 是已知事件
    const knownTypes: SseEventType[] = [
      'message_start', 'content_block_start', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ];
    if (!knownTypes.includes(type)) return null;
    return { type, data };
  } catch {
    return null;
  }
}

// ---- 纯函数：状态累积 ----

/**
 * 无副作用的状态累积：接收当前累积器 + 新事件，返回新累积器
 */
export function accumulateSseEvent(
  acc: MessageAccumulator,
  event: SseEvent,
): MessageAccumulator {
  // 浅拷贝，确保不修改原对象
  const next: MessageAccumulator = {
    ...acc,
    blocks: new Map(acc.blocks),
    usage: { ...acc.usage },
  };

  switch (event.type) {
    case 'message_start': {
      const data = event.data as MessageStartData;
      // 新消息开始：重置 done 和 blocks，保留已累积的 usage（跨请求合计）
      next.done = false;
      next.stopReason = '';
      next.error = '';
      next.blocks = new Map();
      next.model = data.message?.model || '';
      next.messageId = data.message?.id || '';
      if (data.message?.usage) {
        next.usage.inputTokens += data.message.usage.input_tokens || 0;
        next.usage.outputTokens += data.message.usage.output_tokens || 0;
        next.usage.cacheReadInputTokens += data.message.usage.cache_read_input_tokens || 0;
        next.usage.cacheCreationInputTokens += data.message.usage.cache_creation_input_tokens || 0;
      }
      break;
    }

    case 'content_block_start': {
      const data = event.data as ContentBlockStartData;
      const block = data.content_block;
      if (block.type === 'text') {
        next.blocks.set(data.index, { type: 'text', text: block.text || '' });
      } else if (block.type === 'tool_use') {
        next.blocks.set(data.index, {
          type: 'tool_use',
          id: block.id || '',
          name: block.name || '',
          inputJson: '',
        });
      }
      break;
    }

    case 'content_block_delta': {
      const data = event.data as ContentBlockDeltaData;
      const existing = next.blocks.get(data.index);
      if (!existing) break;

      if (existing.type === 'text' && data.delta.type === 'text_delta') {
        next.blocks.set(data.index, {
          ...existing,
          text: existing.text + (data.delta.text || ''),
        });
      } else if (existing.type === 'tool_use' && data.delta.type === 'input_json_delta') {
        next.blocks.set(data.index, {
          ...existing,
          inputJson: existing.inputJson + (data.delta.partial_json || ''),
        });
      }
      break;
    }

    case 'content_block_stop': {
      // block 完成，不需要特殊处理（数据已在 delta 中累积）
      break;
    }

    case 'message_delta': {
      const data = event.data as MessageDeltaData;
      next.stopReason = data.delta?.stop_reason || '';
      if (data.usage) {
        next.usage.outputTokens += data.usage.output_tokens || 0;
      }
      break;
    }

    case 'message_stop': {
      next.done = true;
      break;
    }

    case 'error': {
      const data = event.data as { message?: string; error?: { message?: string } };
      next.error = data.error?.message || data.message || 'Unknown SSE error';
      next.done = true;
      break;
    }

    case 'ping':
      // 忽略
      break;
  }

  return next;
}

// ---- 纯函数：ContainerOutput 映射 ----

/** 与 cli-runner.ts 中的 ContainerOutput 保持一致 */
export interface ContainerOutput {
  status: 'success' | 'error' | 'progress';
  result: string | null;
  newSessionId?: string;
  error?: string;
  progressType?: 'tool_use' | 'tool_result' | 'thinking';
  detail?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    numTurns: number;
    durationMs: number;
    totalCostUsd: number;
    model?: string;
  };
}

/**
 * 从 SSE 事件生成实时 ContainerOutput（工具调用进度）
 * 在 content_block_start type=tool_use 时触发（轻量版，无输入详情）
 */
export function mapSseEventToProgress(event: SseEvent): ContainerOutput | null {
  if (event.type !== 'content_block_start') return null;

  const data = event.data as ContentBlockStartData;
  if (data.content_block?.type !== 'tool_use') return null;

  const name = data.content_block.name || 'unknown';
  const emoji = toolEmoji(name);

  return {
    status: 'progress',
    result: `${emoji} ${name}`,
    progressType: 'tool_use',
  };
}

/** 工具名 → emoji */
function toolEmoji(name: string): string {
  return name === 'Bash' ? '🔧' :
         name === 'Read' ? '📖' :
         name === 'Write' || name === 'Edit' ? '✏️' :
         name === 'Grep' ? '🔍' :
         name === 'Glob' ? '📋' :
         name === 'WebSearch' || name === 'WebFetch' ? '🌐' :
         name === 'Agent' ? '🤖' : '⚙️';
}

/**
 * 从已完成的 ToolUseBlock 生成富进度（包含命令/文件等详情）
 * 在 content_block_stop 时调用，此时 inputJson 已完整累积
 */
export function buildToolUseProgress(block: ToolUseBlock): ContainerOutput | null {
  const name = block.name;
  const emoji = toolEmoji(name);

  let shortInput: string = name;
  let detail: string | undefined;

  try {
    const input = JSON.parse(block.inputJson) as Record<string, unknown>;
    const inputStr = (input.command as string || input.file_path as string ||
                      input.query as string || input.pattern as string || name);
    shortInput = typeof inputStr === 'string' ? inputStr.slice(0, 60) : name;

    if (name === 'Edit' && input.old_string && input.new_string) {
      const file = ((input.file_path as string) || '').split('/').pop() || 'file';
      const oldLines = (input.old_string as string).slice(0, 300).split('\n').map((l: string) => `- ${l}`).join('\n');
      const newLines = (input.new_string as string).slice(0, 300).split('\n').map((l: string) => `+ ${l}`).join('\n');
      detail = `**${file}**\n${oldLines}\n${newLines}`;
    } else if (name === 'Bash' && input.command) {
      detail = `\`\`\`bash\n${(input.command as string).slice(0, 500)}\n\`\`\``;
    } else if (name === 'Write' && input.file_path) {
      const c = (input.content as string || '').slice(0, 300);
      detail = `**${input.file_path}**\n\`\`\`\n${c}${c.length >= 300 ? '\n...' : ''}\n\`\`\``;
    }
  } catch {
    // inputJson 解析失败，用裸工具名
  }

  return {
    status: 'progress',
    result: `${emoji} ${name}: ${shortInput}`,
    progressType: 'tool_use',
    detail,
  };
}

/**
 * 从完成的 MessageAccumulator 生成最终 ContainerOutput
 */
export function mapAccumulatorToResult(
  acc: MessageAccumulator,
  sessionId?: string,
  numTurns?: number,
  durationMs?: number,
): ContainerOutput {
  if (acc.error) {
    return {
      status: 'error',
      result: null,
      error: acc.error,
      newSessionId: sessionId,
    };
  }

  // 收集所有文本 block
  const textParts: string[] = [];
  for (const [, block] of acc.blocks) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    }
  }

  return {
    status: 'success',
    result: textParts.join('') || null,
    newSessionId: sessionId,
    usage: {
      inputTokens: acc.usage.inputTokens,
      outputTokens: acc.usage.outputTokens,
      cacheReadInputTokens: acc.usage.cacheReadInputTokens,
      cacheCreationInputTokens: acc.usage.cacheCreationInputTokens,
      numTurns: numTurns || 0,
      durationMs: durationMs || 0,
      totalCostUsd: 0, // SSE 模式无法获取 cost
      model: acc.model || undefined,
    },
  };
}
