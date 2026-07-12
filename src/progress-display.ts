export type ProgressProvider = 'claude' | 'codex' | 'gemini' | 'legacy';
export type ProgressLifecycle =
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface StructuredProgress {
  provider: ProgressProvider;
  lifecycle: ProgressLifecycle;
  toolName: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  exitCode?: number | null;
  resultSummary?: string;
}

export type ProgressCategory =
  | 'read'
  | 'search'
  | 'change'
  | 'test'
  | 'build'
  | 'inspect'
  | 'observe'
  | 'delivery'
  | 'communicate'
  | 'web'
  | 'script'
  | 'destructive'
  | 'system';

export interface ProgressAction {
  title: string;
  completedTitle?: string;
  actionSummary?: string;
  phase?: string;
  category: ProgressCategory;
  confidence: 'exact' | 'inferred' | 'fallback';
}

export interface PresentationStep extends ProgressAction {
  toolCallId?: string;
  planTaskId?: string;
  phaseId?: string;
  source?: 'tool' | 'plan';
  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unknown';
}

export interface PresentationPhase {
  id: string;
  goal: string;
  source: 'narration' | 'plan' | 'fallback';
  status: PresentationStep['status'];
  currentAction?: string;
  categories: ProgressCategory[];
  actionSummaries?: string[];
  toolCallIds: string[];
  outcome?: string;
  planTaskId?: string;
  testPassCount?: number;
  matchCount?: number;
  matchQuery?: string;
  timingValueCount?: number;
}

export interface ProgressPresentationState {
  activePhaseGoal?: string;
  activePhaseId?: string;
  steps: PresentationStep[];
  phases: PresentationPhase[];
}

export type ProgressPresentationEvent =
  | { kind: 'narration'; text: string }
  | { kind: 'tool'; progress: StructuredProgress }
  | { kind: 'turn_end' };

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

export function isStructuredProgress(
  value: unknown,
): value is StructuredProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  return (
    ['claude', 'codex', 'gemini', 'legacy'].includes(
      String(progress.provider),
    ) &&
    ['started', 'completed', 'failed', 'cancelled', 'unknown'].includes(
      String(progress.lifecycle),
    ) &&
    typeof progress.toolName === 'string' &&
    progress.toolName.trim().length > 0 &&
    (progress.toolCallId === undefined ||
      typeof progress.toolCallId === 'string') &&
    (progress.input === undefined ||
      (!!progress.input &&
        typeof progress.input === 'object' &&
        !Array.isArray(progress.input)))
  );
}

export function serializeProgressPayload(output: {
  result: string;
  detail?: string;
  progress?: StructuredProgress;
}): string {
  if (!output.detail && !output.progress) return output.result;
  return JSON.stringify({
    title: output.result,
    ...(output.detail ? { detail: output.detail } : {}),
    ...(output.progress ? { progress: output.progress } : {}),
  });
}

export function progressLogFields(
  progress: StructuredProgress | undefined,
): Record<string, string | undefined> {
  if (!progress) return {};
  return {
    provider: progress.provider,
    lifecycle: progress.lifecycle,
    toolName: progress.toolName,
    toolCallId: progress.toolCallId,
  };
}

export function progressTransitionLogFields(input: {
  cardMessageId: string;
  toolCallId: string;
  stepCount: number;
  fromStatus: PresentationStep['status'] | 'missing';
  toStatus: PresentationStep['status'];
}): Record<string, string | number> {
  return {
    cardMessageId: input.cardMessageId,
    toolCallId: input.toolCallId,
    stepCount: input.stepCount,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
  };
}

function inputString(
  input: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = input?.[key];
  return typeof value === 'string' ? value : '';
}

function commandOf(progress: StructuredProgress): string {
  return inputString(progress.input, 'command').trim();
}

function taskStatus(progress: StructuredProgress): PresentationStep['status'] {
  const status = inputString(progress.input, 'status').toLowerCase();
  if (status === 'in_progress') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'pending') return 'pending';
  return 'pending';
}

function taskSubject(progress: StructuredProgress): string {
  const subject = sanitizeUserText(
    inputString(progress.input, 'subject') ||
      inputString(progress.input, 'activeForm'),
  );
  return subject || '计划任务';
}

function mcpToolOf(progress: StructuredProgress): string {
  return inputString(progress.input, 'tool').toLowerCase();
}

function safeBasename(value: string): string | undefined {
  const raw = value.trim().replace(/[?#].*$/u, '');
  if (!raw || /^-/u.test(raw)) return undefined;
  const name = raw.split(/[\\/]/u).filter(Boolean).at(-1)?.trim();
  if (!name || name.length > 64 || !/[\p{L}\p{N}._-]/u.test(name))
    return undefined;
  if (/^(?:\.env(?:\..*)?|.*(?:credential|password|secret|token|private[_-]?key).*)$/iu.test(name))
    return '敏感配置文件';
  const safe = sanitizeUserText(name);
  if (
    !safe ||
    safe.includes('[REDACTED') ||
    /相关标识|内部服务|相关文件/u.test(safe)
  )
    return undefined;
  return safe;
}

function safeQuery(value: string): string | undefined {
  const raw = value.trim().replace(/^[`'"“”]+|[`'"“”]+$/gu, '');
  if (
    !raw ||
    raw.length > 80 ||
    /^!/u.test(raw) ||
    ((raw.includes('*') || raw.includes('?') || raw.includes('[')) &&
      /[\\/]/u.test(raw))
  )
    return undefined;
  const safe = sanitizeUserText(raw).replace(/\s+/gu, ' ');
  if (
    !safe ||
    safe.includes('[REDACTED') ||
    /相关标识|内部服务|相关文件/u.test(safe)
  )
    return undefined;
  return safe.length > 32 ? `${safe.slice(0, 32)}…` : safe;
}

function fileObject(progress: StructuredProgress): string | undefined {
  return safeBasename(
    inputString(progress.input, 'file_path') ||
      inputString(progress.input, 'path'),
  );
}

function testObject(command: string): string | undefined {
  const match = command.match(
    /(?:^|[\\/\s'"`])([^\\/\s'"`]+(?:\.test|\.spec)\.[cm]?[jt]sx?|test_[^\\/\s'"`]+\.py|[^\\/\s'"`]+_test\.py)(?=$|\s|['"`])/iu,
  );
  return match ? safeBasename(match[1]) : undefined;
}

function shellTokens(command: string, startIndex: number): string[] {
  const rawTokens =
    command.slice(startIndex).match(/"[^"]*"|'[^']*'|[|;&\n]|[^\s|;&\n]+/gu) ??
    [];
  const controlIndex = rawTokens.findIndex((token) => /^[|;&\n]$/u.test(token));
  return controlIndex >= 0 ? rawTokens.slice(0, controlIndex) : rawTokens;
}

function cleanShellToken(token: string): string {
  return token
    .trim()
    .replace(/\\(["'])/gu, '$1')
    .replace(/^[`'"“”]+|[`'"“”]+$/gu, '');
}

function isQuoteToken(token: string): boolean {
  return !cleanShellToken(token);
}

function shellSearchAction(
  command: string,
  base: { phase?: string },
): ProgressAction | undefined {
  const commandMatch = command.match(/\b(?:rg|grep)\b/iu);
  if (commandMatch?.index == null) return undefined;
  const tokens = shellTokens(command, commandMatch.index);
  const valueFlags = new Set([
    '-A',
    '-B',
    '-C',
    '-g',
    '-m',
    '-t',
    '--after-context',
    '--before-context',
    '--context',
    '--glob',
    '--max-count',
    '--type',
  ]);
  const operands: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = cleanShellToken(tokens[index]);
    if (valueFlags.has(token)) {
      let valueIndex = index + 1;
      while (valueIndex < tokens.length && isQuoteToken(tokens[valueIndex]))
        valueIndex += 1;
      valueIndex += 1;
      while (valueIndex < tokens.length && isQuoteToken(tokens[valueIndex]))
        valueIndex += 1;
      index = valueIndex - 1;
      continue;
    }
    if ([...valueFlags].some((flag) => token.startsWith(`${flag}=`))) continue;
    if (!token) continue;
    if (token.startsWith('-')) continue;
    operands.push(token);
  }
  const query = safeQuery(operands[0] ?? '');
  const target = safeBasename(operands[1] ?? '');
  if (query && target)
    return actionText(
      `正在 ${target} 中搜索“${query}”`,
      `在 ${target} 中搜索“${query}”`,
      base,
      'search',
      'inferred',
    );
  if (query)
    return actionText(
      `正在搜索“${query}”`,
      `搜索“${query}”`,
      base,
      'search',
      'inferred',
    );
  return undefined;
}

function shellReadObject(command: string): string | undefined {
  const commandMatch = command.match(/\b(?:cat|sed)\b/iu);
  if (commandMatch?.index == null) return undefined;
  const tokens = shellTokens(command, commandMatch.index).slice(1);
  const candidate = [...tokens]
    .reverse()
    .map(cleanShellToken)
    .find((token) => !token.startsWith('-') && !/^\d+(?:,\d+)?p$/u.test(token));
  return candidate ? safeBasename(candidate) : undefined;
}

function shellGitHistoryObject(command: string): string | undefined {
  const commandMatch = command.match(/\bgit\s+(?:log|blame|show)\b/iu);
  if (commandMatch?.index == null) return undefined;
  const tokens = shellTokens(command, commandMatch.index).map(cleanShellToken);
  const subcommand = tokens[1]?.toLowerCase();
  if (subcommand === 'blame') {
    const blameValueFlags = new Set(['-L', '--contents', '--date']);
    let candidate: string | undefined;
    for (let index = 2; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (blameValueFlags.has(token)) {
        index += 1;
        continue;
      }
      if (!token || token.startsWith('-')) continue;
      candidate = token;
      break;
    }
    return candidate ? safeBasename(candidate) : undefined;
  }
  const separator = tokens.indexOf('--');
  if (separator < 0) return undefined;
  const candidate = tokens.slice(separator + 1).find(Boolean);
  return candidate ? safeBasename(candidate) : undefined;
}

function actionText(
  running: string,
  completed: string,
  base: { phase?: string },
  category: ProgressCategory,
  confidence: ProgressAction['confidence'] = 'exact',
): ProgressAction {
  return {
    ...base,
    title: running,
    completedTitle: `已${completed}`,
    actionSummary: completed,
    category,
    confidence,
  };
}

function mergeActionSummary(
  phase: PresentationPhase,
  action: ProgressAction,
): string[] | undefined {
  if (!action.actionSummary) return phase.actionSummaries;
  const summaries = [...(phase.actionSummaries ?? [])];
  const categoryIndex = phase.categories.indexOf(action.category);
  if (categoryIndex >= 0) summaries[categoryIndex] = action.actionSummary;
  else summaries.push(action.actionSummary);
  return summaries;
}

function searchObject(progress: StructuredProgress): string | undefined {
  const haystack = [
    inputString(progress.input, 'query'),
    inputString(progress.input, 'pattern'),
    inputString(progress.input, 'path'),
    inputString(progress.input, 'file_path'),
    commandOf(progress),
  ]
    .join(' ')
    .toLowerCase();
  if (/model|claude|codex|gemini|opus|sonnet|haiku/.test(haystack))
    return '模型配置';
  if (/progress|card|过程卡片/.test(haystack)) return '过程卡片';
  if (/session|context|conversation|上下文|会话/.test(haystack))
    return '会话上下文';
  if (/latency|timing|耗时|延迟/.test(haystack)) return '性能数据';
  return undefined;
}

function searchTitle(progress: StructuredProgress): string {
  const object = searchObject(progress);
  return object ? `正在搜索${object}相关位置` : '正在搜索相关内容';
}

function planSteps(progress: StructuredProgress): PresentationStep[] {
  const todos = progress.input?.todos;
  if (!Array.isArray(todos)) return [];
  return todos.slice(0, 20).flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const todo = entry as Record<string, unknown>;
    const content =
      typeof todo.content === 'string'
        ? sanitizeUserText(todo.content.trim()).slice(0, 120)
        : '';
    if (!content) return [];
    const status =
      todo.status === 'completed'
        ? 'completed'
        : todo.status === 'in_progress'
          ? 'running'
          : 'pending';
    return [
      {
        title: content,
        category: 'system' as const,
        confidence: 'exact' as const,
        toolCallId: `${progress.toolCallId ?? 'plan'}:plan:${index}`,
        source: 'plan' as const,
        status,
      },
    ];
  });
}

function sanitizeUserText(text: string): string {
  return redactProgressText(text)
    .replace(/```[\s\S]*?```/gu, '技术操作')
    .replace(/(?:\/[\w.@-]+){2,}/gu, '相关文件')
    .replace(/\b(?:oc|om|ou|trace)_[\w-]+\b/giu, '相关标识')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '内部服务')
    .trim();
}

export function classifyProgressAction(
  progress: StructuredProgress,
  phase?: string,
): ProgressAction {
  const tool = progress.toolName.toLowerCase();
  const command = commandOf(progress);
  const lower = command.toLowerCase();
  const base = { phase };

  if (
    /git\s+push\b[^\n]*(--delete|:\s*)/.test(lower) ||
    /(^|[;&|]\s*)rm\s+(-\S*\s+)*\S+/.test(lower)
  ) {
    return {
      ...base,
      title: lower.includes('git push') ? '正在删除远程分支' : '正在删除文件',
      category: 'destructive',
      confidence: 'exact',
    };
  }
  if (tool === 'read') {
    const target = fileObject(progress);
    return target
      ? actionText(`正在读取 ${target}`, `读取 ${target}`, base, 'read')
      : actionText('正在读取文件', '读取文件', base, 'read');
  }
  if (tool === 'grep' || tool === 'glob') {
    const target = fileObject(progress);
    const query = safeQuery(
      inputString(progress.input, 'pattern') ||
        inputString(progress.input, 'query'),
    );
    if (query && target)
      return actionText(
        `正在 ${target} 中搜索“${query}”`,
        `在 ${target} 中搜索“${query}”`,
        base,
        'search',
      );
    if (query)
      return actionText(
        `正在搜索“${query}”`,
        `搜索“${query}”`,
        base,
        'search',
      );
    return actionText(
      searchTitle(progress),
      searchObject(progress) ? `搜索${searchObject(progress)}` : '搜索相关内容',
      base,
      'search',
    );
  }
  if (tool === 'write' || tool === 'edit' || tool === 'file_change') {
    const target = fileObject(progress);
    return target
      ? actionText(`正在修改 ${target}`, `修改 ${target}`, base, 'change')
      : actionText('正在修改文件', '修改文件', base, 'change');
  }
  if (tool === 'websearch' || tool === 'web_search' || tool === 'webfetch') {
    const query = safeQuery(inputString(progress.input, 'query'));
    return query
      ? actionText(
          `正在搜索“${query}”公开资料`,
          `搜索“${query}”公开资料`,
          base,
          'web',
        )
      : actionText(
          '正在搜索公开资料',
          '搜索公开资料',
          base,
          'web',
        );
  }

  if (tool.includes('gitnexus')) {
    const symbol = safeQuery(inputString(progress.input, 'query'));
    return symbol
      ? actionText(
          `正在分析 ${symbol} 的代码调用关系`,
          `分析 ${symbol} 的代码调用关系`,
          base,
          'inspect',
        )
      : actionText(
          '正在分析代码调用关系',
          '分析代码调用关系',
          base,
          'inspect',
        );
  }
  if (tool.includes('search_chat')) {
    const query = safeQuery(inputString(progress.input, 'query'));
    return query
      ? actionText(
          `正在搜索包含“${query}”的聊天记录`,
          `搜索包含“${query}”的聊天记录`,
          base,
          'communicate',
        )
      : actionText(
          '正在搜索聊天记录',
          '搜索聊天记录',
          base,
          'communicate',
        );
  }
  if (tool.includes('delegate'))
    return {
      ...base,
      title: '正在派发协作任务',
      category: 'communicate',
      confidence: 'exact',
    };
  if (tool.includes('report'))
    return {
      ...base,
      title: '正在提交任务进展',
      category: 'communicate',
      confidence: 'exact',
    };

  if (tool === 'mcp_tool_call') {
    const mcpTool = mcpToolOf(progress);
    if (mcpTool.includes('search_chat'))
      return {
        ...base,
        title: '正在搜索聊天记录',
        category: 'communicate',
        confidence: 'exact',
      };
    if (mcpTool.includes('delegate'))
      return {
        ...base,
        title: '正在派发协作任务',
        category: 'communicate',
        confidence: 'exact',
      };
    if (mcpTool.includes('report'))
      return {
        ...base,
        title: '正在提交任务进展',
        category: 'communicate',
        confidence: 'exact',
      };
    return {
      ...base,
      title: '正在调用协作工具',
      category: 'communicate',
      confidence: 'fallback',
    };
  }

  if (
    /\b(npm|pnpm|yarn)\s+(run\s+)?build\b|\b(go|cargo)\s+build\b|docker\s+build\b/.test(
      lower,
    )
  ) {
    return {
      ...base,
      title: '正在编译项目',
      category: 'build',
      confidence: 'exact',
    };
  }
  if (
    /\b(pytest|vitest|jest)\b|\bnode\s+--test\b|\b(go|cargo)\s+test\b|\b(npm|pnpm|yarn)\s+(run\s+)?test\b/.test(
      lower,
    )
  ) {
    const target = testObject(command);
    return target
      ? actionText(
          `正在运行 ${target} 测试`,
          `测试 ${target}`,
          base,
          'test',
        )
      : actionText('正在运行测试', '运行测试', base, 'test');
  }
  if (/gh\s+run\s+view\b[^\n]*--log-failed/.test(lower)) {
    return {
      ...base,
      title: '正在检查流水线失败原因',
      category: 'delivery',
      confidence: 'exact',
    };
  }
  if (/\bgh\s+(run|workflow)\b/.test(lower))
    return {
      ...base,
      title: '正在检查交付流水线',
      category: 'delivery',
      confidence: 'inferred',
    };
  if (/\bgh\s+pr\b/.test(lower))
    return {
      ...base,
      title: '正在处理代码评审',
      category: 'delivery',
      confidence: 'inferred',
    };
  if (/feishu-docs[^\n]*\bupload\b|lark-cli\s+drive[^\n]*upload/.test(lower)) {
    return {
      ...base,
      title: '正在上传文档',
      category: 'delivery',
      confidence: 'exact',
    };
  }
  if (/lark-cli\s+im\s+\+chat-messages-list/.test(lower)) {
    return {
      ...base,
      title: '正在读取飞书消息',
      category: 'communicate',
      confidence: 'exact',
    };
  }
  if (/(loki|jaeger|grafana)/.test(lower)) {
    return {
      ...base,
      title: /ssh\s+dev\b/.test(lower)
        ? '正在查询 DEV 链路日志'
        : '正在查询链路日志',
      category: 'observe',
      confidence: 'inferred',
    };
  }
  if (/\bopenspec\s+validate\b/.test(lower))
    return {
      ...base,
      title: '正在校验变更规范',
      category: 'inspect',
      confidence: 'exact',
    };
  if (/\bapply_patch\b/.test(lower))
    return {
      ...base,
      title: '正在修改文件',
      category: 'change',
      confidence: 'exact',
    };
  if (/git\s+diff\s+--check/.test(lower))
    return {
      ...base,
      title: '正在检查代码改动',
      category: 'inspect',
      confidence: 'exact',
    };
  if (/\bgit\s+(log|blame|show|status|diff)\b/.test(lower)) {
    const historyTarget = /\bgit\s+(?:blame|log|show)\b/iu.test(command)
      ? shellGitHistoryObject(command)
      : undefined;
    return historyTarget
      ? actionText(
          `正在检查 ${historyTarget} 的代码历史`,
          `检查 ${historyTarget} 的代码历史`,
          base,
          'inspect',
          'inferred',
        )
      : actionText(
          '正在检查代码和历史',
          '检查代码和历史',
          base,
          'inspect',
          'inferred',
        );
  }
  if (/\b(rg|grep)\b/.test(lower)) {
    const action = shellSearchAction(command, base);
    if (action) return action;
  }
  if (/\b(rg|grep|find)\b/.test(lower))
    return actionText(
      searchTitle(progress),
      searchObject(progress) ? `搜索${searchObject(progress)}` : '搜索相关内容',
      base,
      'search',
      'inferred',
    );
  if (/\b(cat|sed)\b/.test(lower)) {
    const target = shellReadObject(command);
    return target
      ? actionText(
          `正在读取 ${target}`,
          `读取 ${target}`,
          base,
          'read',
          'inferred',
        )
      : actionText(
          '正在读取相关内容',
          '读取相关内容',
          base,
          'read',
          'inferred',
        );
  }
  if (/\b(curl|wget)\b/.test(lower))
    return {
      ...base,
      title: '正在检查服务响应',
      category: 'inspect',
      confidence: 'fallback',
    };
  if (/\bssh\b/.test(lower))
    return {
      ...base,
      title: '正在检查远程环境',
      category: 'inspect',
      confidence: 'fallback',
    };
  if (/\b(python\d*|node|ruby|perl)\b/.test(lower))
    return {
      ...base,
      title: phase ? '正在运行分析脚本' : '正在运行脚本',
      category: 'script',
      confidence: 'fallback',
    };

  return {
    ...base,
    title: '正在执行系统检查',
    category: 'system',
    confidence: 'fallback',
  };
}

function firstSentence(text: string): string | undefined {
  const normalized = sanitizeUserText(text.replace(/^💬\s*/u, '').trim());
  if (!normalized) return undefined;
  const sentences = normalized
    .split(/[。！？!?\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const sentence =
    sentences.find(
      (part) => !/^(?:继续|收到|明白|好的?|可以|没问题)$/u.test(part),
    ) ?? sentences[0];
  const core = sentence?.split(/[：:；;]/u)[0]?.trim();
  if (!core) return undefined;
  return core.length > 42 ? core.slice(0, 42) + '…' : core;
}

const CATEGORY_LABELS: Partial<Record<ProgressCategory, string>> = {
  read: '读取',
  search: '搜索',
  change: '修改',
  test: '测试',
  build: '编译',
  inspect: '检查',
  observe: '日志查询',
  delivery: '交付',
  communicate: '协作',
  web: '资料搜索',
  script: '分析脚本',
  destructive: '删除操作',
  system: '系统检查',
};

function resultCount(
  summary: string | undefined,
  pattern: RegExp,
): number | undefined {
  if (!summary) return undefined;
  const match = summary.match(pattern);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function exactMatchCount(
  summary: string | undefined,
  query: string | undefined,
): number | undefined {
  if (!summary || !query) return undefined;
  let count = 0;
  let offset = 0;
  while ((offset = summary.indexOf(query, offset)) >= 0) {
    count += 1;
    offset += query.length;
  }
  return count > 0 ? count : undefined;
}

function testPassCount(summary: string | undefined): number | undefined {
  return (
    resultCount(summary, /\b(\d+)\s+(?:tests?\s+)?passed\b/iu) ??
    resultCount(summary, /\bpass(?:ed)?\s*[:=]?\s*(\d+)\b/iu) ??
    resultCount(summary, /\b(\d+)\s*项(?:测试)?通过\b/iu)
  );
}

function timingValueCount(summary: string | undefined): number | undefined {
  if (!summary) return undefined;
  const match = summary.match(
    /(?:^|\s)(-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?){1,})(?:\s|$)/u,
  );
  return match ? match[1].split(',').length : undefined;
}

function chineseList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]}，并${items[1]}`;
  return `${items.slice(0, -1).join('、')}，并${items.at(-1)}`;
}

function aggregateOutcome(
  phase: PresentationPhase,
  progress: StructuredProgress,
  status: PresentationStep['status'],
): string {
  if (status === 'failed') {
    if (progress.exitCode != null)
      return `命令执行失败（退出码 ${progress.exitCode}）`;
    return phase.categories.includes('test') ? '测试失败' : '执行失败';
  }
  if (status === 'cancelled') return '已取消';
  if (status === 'unknown') return '已执行，结果未知';

  const summary = progress.resultSummary;
  if (phase.categories.includes('communicate')) {
    const count = phase.matchCount ?? resultCount(summary, /\b(\d+)\s*条/iu);
    if (count != null) return `找到 ${count} 条匹配消息`;
  }
  if (/计时|耗时|延迟/u.test(phase.goal)) {
    const count = phase.timingValueCount ?? timingValueCount(summary);
    if (count != null) return `已获得 ${count} 个计时值`;
  }

  const labels = phase.categories.map(
    (category) => CATEGORY_LABELS[category] ?? '操作',
  );
  const testCount = phase.categories.includes('test')
    ? (phase.testPassCount ?? testPassCount(summary))
    : undefined;
  const summaries = phase.actionSummaries ?? [];
  if (
    summaries.length === 0 &&
    labels.length === 1 &&
    phase.categories[0] === 'test' &&
    testCount != null
  )
    return `${testCount} 项测试通过`;
  const base =
    summaries.length > 0
      ? `已${chineseList(summaries)}`
      : `已完成${chineseList(labels)}`;
  return testCount != null ? `${base}（${testCount} 项通过）` : base;
}

function mergeResultFacts(
  phase: PresentationPhase,
  progress: StructuredProgress,
): PresentationPhase {
  const summary = progress.resultSummary;
  return {
    ...phase,
    testPassCount:
      phase.testPassCount ??
      (phase.categories.includes('test') ? testPassCount(summary) : undefined),
    matchCount:
      phase.matchCount ??
      (phase.categories.includes('communicate')
        ? (exactMatchCount(summary, phase.matchQuery) ??
          resultCount(summary, /\b(\d+)\s*条/iu))
        : undefined),
    timingValueCount:
      phase.timingValueCount ??
      (/计时|耗时|延迟/u.test(phase.goal)
        ? timingValueCount(summary)
        : undefined),
  };
}

export function presentationPhaseTitle(phase: PresentationPhase): string {
  if (phase.status === 'pending') return `待处理：${phase.goal}`;
  if (phase.status === 'running') {
    if (phase.source === 'plan' && !phase.currentAction)
      return `进行中：${phase.goal}`;
    if (!phase.currentAction || phase.currentAction === phase.goal)
      return phase.goal;
    return `${phase.goal} · ${phase.currentAction}`;
  }
  if (phase.source === 'fallback')
    return phase.outcome ?? phase.currentAction ?? phase.goal;
  if (phase.status === 'unknown')
    return `${phase.goal} · ${phase.outcome ?? '已执行，结果未知'}`;
  if (phase.outcome) return `${phase.goal} · ${phase.outcome}`;
  if (phase.status === 'completed') return `已完成：${phase.goal}`;
  if (phase.status === 'cancelled') return `${phase.goal} · 已取消`;
  return `${phase.goal} · 执行失败`;
}

function upsertPhaseForStarted(
  state: ProgressPresentationState,
  action: ProgressAction,
  toolCallId: string | undefined,
  planStep?: PresentationStep,
  matchQuery?: string,
): {
  phases: PresentationPhase[];
  phaseId: string;
  activePhaseId?: string;
} {
  const phases = [...state.phases];
  const source: PresentationPhase['source'] = planStep
    ? 'plan'
    : state.activePhaseGoal
      ? 'narration'
      : 'fallback';
  const goal = planStep?.title ?? state.activePhaseGoal ?? action.title;
  let phaseIndex = planStep
    ? phases.findIndex(
        (phase) =>
          phase.source === 'plan' &&
          ((planStep.planTaskId && phase.planTaskId === planStep.planTaskId) ||
            phase.goal === planStep.title),
      )
    : state.activePhaseId
      ? phases.findIndex((phase) => phase.id === state.activePhaseId)
      : -1;
  if (phaseIndex < 0) {
    const id = `phase-${phases.length + 1}`;
    phases.push({
      id,
      goal,
      source,
      status: 'running',
      currentAction: action.title,
      categories: [action.category],
      actionSummaries: action.actionSummary ? [action.actionSummary] : [],
      toolCallIds: toolCallId ? [toolCallId] : [],
      planTaskId: planStep?.planTaskId,
      matchQuery,
    });
    phaseIndex = phases.length - 1;
  } else {
    const phase = phases[phaseIndex];
    phases[phaseIndex] = {
      ...phase,
      status: 'running',
      currentAction: action.title,
      categories: phase.categories.includes(action.category)
        ? phase.categories
        : [...phase.categories, action.category],
      actionSummaries: mergeActionSummary(phase, action),
      toolCallIds:
        toolCallId && !phase.toolCallIds.includes(toolCallId)
          ? [...phase.toolCallIds, toolCallId]
          : phase.toolCallIds,
      outcome: undefined,
      planTaskId: phase.planTaskId ?? planStep?.planTaskId,
      matchQuery: phase.matchQuery ?? matchQuery,
    };
  }
  return {
    phases,
    phaseId: phases[phaseIndex].id,
    activePhaseId: planStep ? state.activePhaseId : phases[phaseIndex].id,
  };
}

function completedTitle(step: PresentationStep): string {
  if (step.completedTitle) return step.completedTitle;
  if (step.title.startsWith('正在')) return `已${step.title.slice(2)}`;
  return step.title;
}

function failedTitle(category: ProgressCategory): string {
  if (category === 'test') return '测试失败';
  if (category === 'build') return '编译失败';
  return '执行失败';
}

function unknownTitle(category: ProgressCategory): string {
  const labels: Partial<Record<ProgressCategory, string>> = {
    test: '已执行测试，结果未知',
    build: '已执行编译，结果未知',
    read: '已执行读取，结果未知',
    search: '已执行搜索，结果未知',
    change: '已执行修改，结果未知',
  };
  return labels[category] ?? '已执行，结果未知';
}

export function createProgressPresentationState(): ProgressPresentationState {
  return { steps: [], phases: [] };
}

function unknownPhaseOutcome(phase: PresentationPhase): string {
  const labels = phase.categories.map(
    (category) => CATEGORY_LABELS[category] ?? '操作',
  );
  return labels.length > 0
    ? `已执行${chineseList(labels)}，结果未知`
    : '已执行，结果未知';
}

export function reduceProgressPresentation(
  state: ProgressPresentationState,
  event: ProgressPresentationEvent,
): ProgressPresentationState {
  if (event.kind === 'narration') {
    const goal = firstSentence(event.text) ?? '正在处理任务';
    const fallbackIndex =
      state.phases.length > 0 &&
      state.phases.every((phase) => phase.source === 'fallback')
        ? state.phases.length - 1
        : -1;
    if (fallbackIndex >= 0) {
      const phases = [...state.phases];
      phases[fallbackIndex] = {
        ...phases[fallbackIndex],
        goal,
        source: 'narration',
      };
      return {
        ...state,
        activePhaseGoal: goal,
        activePhaseId: phases[fallbackIndex].id,
        phases,
      };
    }
    return {
      ...state,
      activePhaseGoal: goal,
      activePhaseId: undefined,
    };
  }
  if (event.kind === 'turn_end') {
    return {
      ...state,
      activePhaseGoal: undefined,
      activePhaseId: undefined,
      steps: state.steps.map((step) =>
        step.status === 'running'
          ? step.source === 'plan'
            ? step
            : { ...step, status: 'unknown', title: unknownTitle(step.category) }
          : step,
      ),
      phases: state.phases.map((phase) =>
        phase.status === 'running'
          ? phase.source === 'plan'
            ? phase
            : { ...phase, status: 'unknown', outcome: unknownPhaseOutcome(phase) }
          : phase,
      ),
    };
  }

  const progress = event.progress;
  if (progress.lifecycle === 'started') {
    const toolName = progress.toolName.toLowerCase();
    if (toolName === 'todowrite') {
      const realPlan = planSteps(progress);
      if (realPlan.length > 0) {
        return {
          activePhaseGoal: undefined,
          activePhaseId: undefined,
          steps: [
            ...state.steps.filter((step) => step.source !== 'plan'),
            ...realPlan,
          ],
          phases: [
            ...state.phases.filter((phase) => phase.source !== 'plan'),
            ...realPlan.map((step, index) => ({
              id: `plan-${index + 1}`,
              goal: step.title,
              source: 'plan' as const,
              status: step.status,
              categories: [] as ProgressCategory[],
              toolCallIds: [],
            })),
          ],
        };
      }
    }
    if (toolName === 'taskcreate') {
      return {
        ...state,
        activePhaseGoal: undefined,
        activePhaseId: undefined,
        steps: [
          ...state.steps,
          {
            title: taskSubject(progress),
            category: 'system',
            confidence: 'exact',
            toolCallId: progress.toolCallId,
            source: 'plan',
            status: 'pending',
          },
        ],
        phases: [
          ...state.phases,
          {
            id: `plan-${state.phases.length + 1}`,
            goal: taskSubject(progress),
            source: 'plan',
            status: 'pending',
            categories: [],
            toolCallIds: [],
          },
        ],
      };
    }
    if (toolName === 'taskupdate') {
      const taskId = inputString(progress.input, 'taskId');
      const taskIndex = state.steps.findIndex(
        (step) => step.source === 'plan' && step.planTaskId === taskId,
      );
      if (taskIndex >= 0) {
        const steps = [...state.steps];
        steps[taskIndex] = {
          ...steps[taskIndex],
          title: inputString(progress.input, 'subject')
            ? taskSubject(progress)
            : steps[taskIndex].title,
          toolCallId: progress.toolCallId,
          status: taskStatus(progress),
        };
        const phases = state.phases.map((phase) =>
          phase.source === 'plan' &&
          (phase.planTaskId === taskId || phase.goal === steps[taskIndex].title)
            ? { ...phase, status: taskStatus(progress) }
            : phase,
        );
        return {
          ...state,
          activePhaseGoal: undefined,
          activePhaseId: undefined,
          steps,
          phases,
        };
      }
    }
    if (toolName === 'toolsearch') {
      const action = classifyProgressAction(progress);
      return {
        ...state,
        steps: [
          ...state.steps,
          {
            ...action,
            toolCallId: progress.toolCallId,
            source: 'tool',
            status: 'running',
          },
        ],
      };
    }
    const runningPlan = state.steps.find(
      (step) => step.source === 'plan' && step.status === 'running',
    );
    const action = classifyProgressAction(
      progress,
      runningPlan?.title ?? state.activePhaseGoal,
    );
    const existingIndex = progress.toolCallId
      ? state.steps.findIndex((step) => step.toolCallId === progress.toolCallId)
      : -1;
    if (existingIndex >= 0) {
      const steps = [...state.steps];
      const existingStep = steps[existingIndex];
      steps[existingIndex] = {
        ...existingStep,
        ...action,
        phase: action.phase ?? existingStep.phase,
        status: 'running',
      };
      const phases = state.phases.map((phase) =>
        phase.id === existingStep.phaseId
          ? {
              ...phase,
              goal: phase.source === 'fallback' ? action.title : phase.goal,
              currentAction: action.title,
              categories: [action.category],
              actionSummaries: action.actionSummary
                ? [action.actionSummary]
                : phase.actionSummaries,
              status: 'running' as const,
              outcome: undefined,
            }
          : phase,
      );
      return { ...state, steps, phases };
    }
    const phase = upsertPhaseForStarted(
      state,
      action,
      progress.toolCallId,
      runningPlan,
      action.category === 'communicate'
        ? inputString(progress.input, 'query')
        : undefined,
    );
    return {
      ...state,
      activePhaseId: phase.activePhaseId,
      phases: phase.phases,
      steps: [
        ...state.steps,
        {
          ...action,
          phaseId: phase.phaseId,
          toolCallId: progress.toolCallId,
          source: 'tool',
          status: 'running',
        },
      ],
    };
  }

  const index = progress.toolCallId
    ? state.steps.findIndex((step) => step.toolCallId === progress.toolCallId)
    : -1;
  if (index < 0) return state;
  const step = state.steps[index];
  if (step.source === 'plan') {
    const createdTaskId = progress.resultSummary?.match(
      /\bTask\s+#(\d+)\s+created\b/iu,
    )?.[1];
    if (!createdTaskId) return state;
    const steps = [...state.steps];
    steps[index] = { ...step, planTaskId: createdTaskId };
    const phases = state.phases.map((phase) =>
      phase.source === 'plan' && phase.goal === step.title
        ? { ...phase, planTaskId: createdTaskId }
        : phase,
    );
    return { ...state, steps, phases };
  }
  const status =
    progress.lifecycle === 'completed' &&
    (progress.exitCode == null || progress.exitCode === 0)
      ? 'completed'
      : progress.lifecycle === 'cancelled'
        ? 'cancelled'
        : progress.lifecycle === 'failed' ||
            (progress.exitCode != null && progress.exitCode !== 0)
          ? 'failed'
          : 'unknown';
  const title =
    status === 'completed'
      ? completedTitle(step)
      : status === 'failed'
        ? failedTitle(step.category)
        : status === 'cancelled'
          ? '已取消'
          : unknownTitle(step.category);
  const steps = [...state.steps];
  steps[index] = { ...step, status, title };
  const phases = state.phases.map((phase) => {
    if (phase.id !== step.phaseId) return phase;
    const runningTool = [...steps]
      .reverse()
      .find(
        (candidate) =>
          candidate.phaseId === phase.id && candidate.status === 'running',
      );
    const hasRunningTool = !!runningTool;
    const phaseStatus: PresentationStep['status'] = hasRunningTool
      ? 'running'
      : status;
    const enrichedPhase = mergeResultFacts(phase, progress);
    return {
      ...enrichedPhase,
      status: phaseStatus,
      currentAction: runningTool?.title ?? title,
      outcome: hasRunningTool
        ? enrichedPhase.outcome
        : aggregateOutcome(enrichedPhase, progress, phaseStatus),
    };
  });
  return { ...state, steps, phases };
}
