export interface StructuredProgress {
  provider: 'claude' | 'codex' | 'gemini' | 'legacy';
  lifecycle: 'started' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  toolName: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  exitCode?: number | null;
  resultSummary?: string;
}

export interface ClaudeToolResultBlock {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ClaudeToolResultProgress {
  result: string;
  detail?: string;
  progress: StructuredProgress;
}

export function redactProgressText(text: string): string {
  return text
    .replace(
      /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)* PRIVATE KEY-----/giu,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/gu,
      '[REDACTED_TOKEN]',
    )
    .replace(/(https?:\/\/)[^\/\s:@]+:[^\/\s@]+@/giu, '$1[REDACTED]@')
    .replace(
      /([?&](?:access_token|api[_-]?key|token|secret|password)=)[^&\s]+/giu,
      '$1[REDACTED]',
    )
    .replace(
      /((?:[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD)|authorization)["']?\s*[:=]\s*["']?)[^"'\s,;]+/giu,
      '$1[REDACTED]',
    );
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const block = item as { type?: string; text?: string };
      return block.type === 'text' && block.text ? [block.text] : [];
    })
    .join('\n')
    .trim();
}

export function buildClaudeToolResultProgress(
  block: ClaudeToolResultBlock,
): ClaudeToolResultProgress | null {
  if (block.type !== 'tool_result') return null;
  const text = redactProgressText(toolResultText(block.content));
  const lifecycle = block.is_error ? 'failed' : 'completed';
  const short = text ? text.slice(0, 60) + (text.length > 60 ? '...' : '') : '';
  return {
    result: text
      ? `${block.is_error ? '❌' : '✅'} 结果: ${short}`
      : block.is_error
        ? '❌ 执行失败'
        : '✅ 执行完成',
    detail: text.length > 60 ? text.slice(0, 1000) : undefined,
    progress: {
      provider: 'claude',
      lifecycle,
      toolName: 'tool_result',
      toolCallId: block.tool_use_id,
      resultSummary: short || undefined,
    },
  };
}

const MAX_VALUE_LENGTH = 2_000;
const SAFE_STRING_KEYS = new Set([
  'activeForm',
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'server',
  'status',
  'subject',
  'taskId',
  'tool',
]);

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, MAX_VALUE_LENGTH);
}

/** 只保留进度分类需要的字段，避免把文件正文、凭证或完整环境变量传给 host。 */
export function boundProgressInput(
  input: unknown,
): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return undefined;
  const source = input as Record<string, unknown>;
  const bounded: Record<string, unknown> = {};
  for (const key of SAFE_STRING_KEYS) {
    const value = boundedString(source[key]);
    if (value !== undefined) bounded[key] = value;
  }
  if (Array.isArray(source.changes)) {
    bounded.changes = source.changes.slice(0, 20).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const change = entry as Record<string, unknown>;
      const path = boundedString(change.path);
      const kind = boundedString(change.kind);
      return path
        ? [
            {
              path: path.slice(0, 500),
              ...(kind ? { kind: kind.slice(0, 40) } : {}),
            },
          ]
        : [];
    });
  }
  if (Array.isArray(source.todos)) {
    bounded.todos = source.todos.slice(0, 20).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const todo = entry as Record<string, unknown>;
      const content = boundedString(todo.content);
      const status = boundedString(todo.status);
      if (!content) return [];
      return [
        {
          content: content.slice(0, 200),
          status:
            status && ['pending', 'in_progress', 'completed'].includes(status)
              ? status
              : 'pending',
        },
      ];
    });
  }
  return Object.keys(bounded).length > 0 ? bounded : undefined;
}
