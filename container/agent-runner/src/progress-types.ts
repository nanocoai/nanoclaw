export interface StructuredProgress {
  provider: 'claude' | 'codex' | 'gemini' | 'legacy';
  lifecycle: 'started' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  toolName: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  exitCode?: number | null;
  resultSummary?: string;
}

const MAX_VALUE_LENGTH = 2_000;
const SAFE_STRING_KEYS = new Set([
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'server',
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
      return [{
        content: content.slice(0, 200),
        status: status && ['pending', 'in_progress', 'completed'].includes(status)
          ? status
          : 'pending',
      }];
    });
  }
  return Object.keys(bounded).length > 0 ? bounded : undefined;
}
