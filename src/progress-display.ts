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
  phase?: string;
  category: ProgressCategory;
  confidence: 'exact' | 'inferred' | 'fallback';
}

export interface PresentationStep extends ProgressAction {
  toolCallId?: string;
  source?: 'tool' | 'plan';
  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unknown';
}

export interface ProgressPresentationState {
  pendingPhase?: string;
  steps: PresentationStep[];
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
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/giu,
      'Bearer [REDACTED]',
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/gu,
      '[REDACTED_TOKEN]',
    )
    .replace(
      /(https?:\/\/)[^\/\s:@]+:[^\/\s@]+@/giu,
      '$1[REDACTED]@',
    )
    .replace(
      /([?&](?:access_token|api[_-]?key|token|secret|password)=)[^&\s]+/giu,
      '$1[REDACTED]',
    )
    .replace(
      /((?:[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD)|authorization)["']?\s*[:=]\s*["']?)[^"'\s,;]+/giu,
      '$1[REDACTED]',
    );
}

export function isStructuredProgress(value: unknown): value is StructuredProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  return (
    ['claude', 'codex', 'gemini', 'legacy'].includes(String(progress.provider)) &&
    ['started', 'completed', 'failed', 'cancelled', 'unknown'].includes(
      String(progress.lifecycle),
    ) &&
    typeof progress.toolName === 'string' &&
    progress.toolName.trim().length > 0 &&
    (progress.toolCallId === undefined || typeof progress.toolCallId === 'string') &&
    (progress.input === undefined ||
      (!!progress.input && typeof progress.input === 'object' && !Array.isArray(progress.input)))
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

function mcpToolOf(progress: StructuredProgress): string {
  return inputString(progress.input, 'tool').toLowerCase();
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
  return text
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
  if (tool === 'read')
    return {
      ...base,
      title: '正在读取文件',
      category: 'read',
      confidence: 'exact',
    };
  if (tool === 'grep' || tool === 'glob')
    return {
      ...base,
      title: searchTitle(progress),
      category: 'search',
      confidence: 'exact',
    };
  if (tool === 'write' || tool === 'edit' || tool === 'file_change')
    return {
      ...base,
      title: '正在修改文件',
      category: 'change',
      confidence: 'exact',
    };
  if (tool === 'websearch' || tool === 'web_search' || tool === 'webfetch')
    return {
      ...base,
      title: '正在搜索公开资料',
      category: 'web',
      confidence: 'exact',
    };

  if (tool.includes('gitnexus'))
    return {
      ...base,
      title: '正在分析代码调用关系',
      category: 'inspect',
      confidence: 'exact',
    };
  if (tool.includes('search_chat'))
    return {
      ...base,
      title: '正在搜索聊天记录',
      category: 'communicate',
      confidence: 'exact',
    };
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
    /\b(pytest|vitest|jest)\b|\b(go|cargo)\s+test\b|\b(npm|pnpm|yarn)\s+(run\s+)?test\b/.test(
      lower,
    )
  ) {
    return {
      ...base,
      title: '正在运行测试',
      category: 'test',
      confidence: 'exact',
    };
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
  if (/\bgit\s+(log|blame|show|status|diff)\b/.test(lower))
    return {
      ...base,
      title: '正在检查代码和历史',
      category: 'inspect',
      confidence: 'inferred',
    };
  if (/\b(rg|grep|find)\b/.test(lower))
    return {
      ...base,
      title: searchTitle(progress),
      category: 'search',
      confidence: 'inferred',
    };
  if (/\b(cat|sed)\b/.test(lower))
    return {
      ...base,
      title: '正在读取相关内容',
      category: 'read',
      confidence: 'inferred',
    };
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
  const match = normalized.match(/^.*?[。！？!?]/u);
  const sentence = (match?.[0] ?? normalized.split('\n')[0]).trim();
  return sentence.length > 42 ? sentence.slice(0, 42) + '…' : sentence;
}

function completedTitle(category: ProgressCategory): string {
  const labels: Partial<Record<ProgressCategory, string>> = {
    test: '已完成测试',
    build: '已完成编译',
    read: '已完成读取',
    search: '已完成搜索',
    change: '已完成修改',
    inspect: '已完成检查',
    observe: '已完成日志查询',
    delivery: '已完成交付操作',
    communicate: '已完成协作操作',
    web: '已完成资料搜索',
    script: '已执行分析脚本',
    destructive: '已完成删除操作',
    system: '已执行系统检查',
  };
  return labels[category] ?? '已执行';
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
  return { steps: [] };
}

export function reduceProgressPresentation(
  state: ProgressPresentationState,
  event: ProgressPresentationEvent,
): ProgressPresentationState {
  if (event.kind === 'narration')
    return { ...state, pendingPhase: firstSentence(event.text) };
  if (event.kind === 'turn_end') {
    return {
      ...state,
      pendingPhase: undefined,
      steps: state.steps.map((step) =>
        step.status === 'running'
          ? step.source === 'plan'
            ? { ...step, status: 'unknown' }
            : { ...step, status: 'unknown', title: unknownTitle(step.category) }
          : step,
      ),
    };
  }

  const progress = event.progress;
  if (progress.lifecycle === 'started') {
    if (progress.toolName.toLowerCase() === 'todowrite') {
      const realPlan = planSteps(progress);
      if (realPlan.length > 0) {
        return {
          pendingPhase: undefined,
          steps: [
            ...state.steps.filter((step) => step.source !== 'plan'),
            ...realPlan,
          ],
        };
      }
    }
    const runningPlan = state.steps.find(
      (step) => step.source === 'plan' && step.status === 'running',
    );
    const action = classifyProgressAction(
      progress,
      state.pendingPhase ?? runningPlan?.title,
    );
    const existingIndex = progress.toolCallId
      ? state.steps.findIndex((step) => step.toolCallId === progress.toolCallId)
      : -1;
    if (existingIndex >= 0) {
      const steps = [...state.steps];
      steps[existingIndex] = {
        ...steps[existingIndex],
        ...action,
        phase: action.phase ?? steps[existingIndex].phase,
        status: 'running',
      };
      return { pendingPhase: undefined, steps };
    }
    return {
      pendingPhase: undefined,
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

  const index = progress.toolCallId
    ? state.steps.findIndex((step) => step.toolCallId === progress.toolCallId)
    : -1;
  if (index < 0) return state;
  const step = state.steps[index];
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
      ? completedTitle(step.category)
      : status === 'failed'
        ? failedTitle(step.category)
        : status === 'cancelled'
          ? '已取消'
          : unknownTitle(step.category);
  const steps = [...state.steps];
  steps[index] = { ...step, status, title };
  return { ...state, steps };
}
