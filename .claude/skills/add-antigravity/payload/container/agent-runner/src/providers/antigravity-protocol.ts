/**
 * The agy headless protocol (`--input-format stream-json --output-format
 * stream-json`), as observed from agy 1.5.8: pure parsing and mapping, no I/O.
 *
 * stdin:  one `{"event":"user","message":{"content":"…"}}` line per turn.
 * stdout: `init` once per process, `step_update` while a turn runs, and one
 *         `result` per turn.
 * stderr: human lines (`error: …`, `warning: conversation "<id>" not found`)
 *         and, on process-level failures, `AGY_ERROR: {json}`.
 */

export interface AntigravityInitEvent {
  event: 'init';
  conversation_id?: string;
  init?: { cwd?: string; model?: string; tools?: string[]; permission_mode?: string };
}

export interface AntigravityToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
  output?: string;
  error?: string;
}

export interface AntigravityStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: 'ACTIVE' | 'DONE' | 'ERROR' | string;
  step_type?: string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: AntigravityToolInfo;
}

export interface AntigravityStepEvent {
  event: 'step_update';
  step_update?: AntigravityStepUpdate;
}

export interface AntigravityTurnResult {
  conversation_id?: string;
  /** SUCCESS | ERROR | CANCELED | INTERRUPTED | … */
  status?: string;
  response?: string;
  error?: string;
  finished_reason?: string;
}

export interface AntigravityResultEvent {
  event: 'result';
  result?: AntigravityTurnResult;
}

export type AntigravityEvent = AntigravityInitEvent | AntigravityStepEvent | AntigravityResultEvent;

/** The `AGY_ERROR:` stderr payload. Only the fields the provider acts on. */
export interface AntigravityStderrError {
  short_error?: string;
  retryable?: boolean;
}

export type AntigravityStderrLine =
  | { kind: 'agy-error'; error: AntigravityStderrError }
  | { kind: 'error'; message: string }
  | { kind: 'conversation-not-found'; conversationId: string }
  | { kind: 'other' };

/** Delimits the per-session system context at the head of a process's first user line. */
export const ANTIGRAVITY_SYSTEM_CONTEXT_TAG = 'nanoclaw_system_context';

/**
 * The first user turn a process receives: the session's system context in a
 * delimited block, then the prompt. A resumed conversation already holds an
 * earlier block; the fresh one follows it, and the rule file tells the agent
 * the newest block wins.
 */
export function renderAntigravityFirstTurn(instructions: string | undefined, prompt: string): string {
  const context = instructions?.trim();
  if (!context) return prompt;
  return `<${ANTIGRAVITY_SYSTEM_CONTEXT_TAG}>\n${context}\n</${ANTIGRAVITY_SYSTEM_CONTEXT_TAG}>\n\n${prompt}`;
}

export function renderAntigravityUserLine(text: string): string {
  return JSON.stringify({ event: 'user', message: { content: text } }) + '\n';
}

/** Null for blank lines, non-JSON output, and event kinds the provider does not consume. */
export function parseAntigravityLine(line: string): AntigravityEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const event = (parsed as { event?: unknown }).event;
  if (event === 'init' || event === 'step_update' || event === 'result') return parsed as AntigravityEvent;
  return null;
}

export function parseAntigravityStderrLine(line: string): AntigravityStderrLine {
  const trimmed = line.trim();
  const agyError = /^AGY_ERROR:\s*(\{.*\})$/.exec(trimmed);
  if (agyError) {
    try {
      const parsed = JSON.parse(agyError[1]) as AntigravityStderrError;
      if (parsed && typeof parsed === 'object') return { kind: 'agy-error', error: parsed };
    } catch {
      /* fall through: an unparseable AGY_ERROR is just another stderr line */
    }
  }
  const notFound = /^warning:\s*conversation\s+"([^"]*)"\s+not found/i.exec(trimmed);
  if (notFound) return { kind: 'conversation-not-found', conversationId: notFound[1] };
  const error = /^error:\s*(.+)$/.exec(trimmed);
  if (error) return { kind: 'error', message: error[1] };
  return { kind: 'other' };
}

/** agy's own wording for a missing `--conversation` id: `conversation "<id>" not found`. */
export const STALE_CONVERSATION_RE = /conversation\s+"[^"\n]+"\s+not found|unknown conversation/i;

/**
 * A progress line for a tool step: once when it starts, once more if it
 * fails. MCP calls go through the built-in `call_mcp_tool`, so those name
 * the server and tool instead.
 */
export function stepProgressMessage(step: AntigravityStepUpdate | undefined): string | null {
  if (!step || step.step_type !== 'tool') return null;
  const label = toolLabel(step);
  if (step.state === 'ACTIVE') return `${label}…`;
  if (step.state === 'ERROR') return `${label} failed`;
  return null;
}

function toolLabel(step: AntigravityStepUpdate): string {
  const name = step.tool_name || step.tool_info?.name || 'tool';
  const params = step.tool_info?.parameters;
  if (name === 'call_mcp_tool' && params) {
    const server = typeof params.ServerName === 'string' ? params.ServerName : undefined;
    const tool = typeof params.ToolName === 'string' ? params.ToolName : undefined;
    if (server && tool) return `${server}/${tool}`;
  }
  return name;
}

export type AntigravityErrorClass = 'auth' | 'quota' | 'network' | 'interrupted' | 'stale-session';

export function classifyAntigravityError(message: string): AntigravityErrorClass | undefined {
  if (STALE_CONVERSATION_RE.test(message)) return 'stale-session';
  if (/\binterrupted\b|\bcancell?ed\b/i.test(message)) return 'interrupted';
  if (/api[_ ]?key|unauthori[sz]ed|unauthenticated|permission[_ ]denied|forbidden|\b40[13]\b|credential/i.test(message))
    return 'auth';
  if (/quota|rate[ -]?limit|resource[_ ]exhausted|\b429\b|billing/i.test(message)) return 'quota';
  if (
    /dial tcp|connection (?:refused|reset)|no such host|i\/o timeout|timed out|tls|certificate|proxyconnect|\bEOF\b/i.test(
      message,
    )
  )
    return 'network';
  return undefined;
}

const NOTICES: Record<AntigravityErrorClass, string> = {
  auth:
    'Antigravity could not authenticate with the Gemini API. To replace the Gemini API key, run ' +
    '`pnpm exec tsx setup/index.ts --step provider-auth antigravity` in a terminal on the NanoClaw host and choose ' +
    'Replace; also check that the credential gateway allows generativelanguage.googleapis.com.',
  quota:
    'The Gemini API refused the request for quota or rate-limit reasons. Wait and try again, or check billing for the API key.',
  network: 'Antigravity could not reach the Gemini API (network or gateway error). Try again shortly.',
  interrupted: 'The Antigravity turn was interrupted before it finished.',
  'stale-session': 'The previous Antigravity conversation could not be found; the next message starts a new one.',
};

/**
 * The channel notice for a failed turn. Known failure classes get a fixed,
 * actionable sentence; anything else carries agy's first error line, capped,
 * so request URLs and stack noise stay in the runner log.
 */
export function antigravityFailureNotice(message: string, classification = classifyAntigravityError(message)): string {
  if (classification) return NOTICES[classification];
  const firstLine = message.split('\n')[0].trim();
  const capped = firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine;
  return capped ? `Antigravity turn failed: ${capped}` : 'Antigravity turn failed.';
}
