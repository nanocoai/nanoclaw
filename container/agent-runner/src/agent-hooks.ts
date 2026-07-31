import { execFile } from 'node:child_process';
import path from 'node:path';

import type { MessageInRow } from './db/messages-in.js';
import { getOutboundDb, touchHeartbeat } from './db/connection.js';
import type { RoutingContext } from './formatter.js';

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_BUFFER = 64 * 1024;
const MAX_AUDIT_RUNS = 100;
const HOOK_AUDIT_KEY = 'agent_hook_runs';

export type AgentHookPhase = 'before_agent_call' | 'after_agent_call';
export type AgentHookRuntime = 'builtin' | 'command';
export type AgentHookStatus = 'continue' | 'noop' | 'mutate' | 'block' | 'retry' | 'require_human_review';
export type AgentHookErrorAction = 'block' | 'continue' | 'require_human_review' | 'skip';

export interface AgentHookDefinition {
  id: string;
  priority?: number;
  runtime: AgentHookRuntime;
  procedure?: string;
  command?: string[];
  required?: boolean;
  config?: Record<string, unknown>;
  timeout_ms?: number;
  on_error?: AgentHookErrorAction;
}

export interface AgentHooksConfig {
  before_agent_call?: AgentHookDefinition[];
  after_agent_call?: AgentHookDefinition[];
}

interface HookDescriptor {
  id: string;
  scope: string;
  version?: string;
}

export interface AgentHookInput {
  schema_version: 'agent-hook.v1';
  phase: AgentHookPhase;
  hook: HookDescriptor;
  call: {
    id: string;
    session_id?: string;
    agent_group_id?: string;
    agent_name?: string;
    destination?: string | null;
    trigger: 'message' | 'task' | 'manual' | 'api';
    created_at: string;
  };
  actor?: {
    kind: 'user' | 'agent' | 'system' | 'task';
    id?: string;
    display_name?: string;
  };
  request: {
    messages: Array<Record<string, unknown>>;
    prompt: string;
    attachments: unknown[];
    metadata: Record<string, unknown>;
  };
  runtime: {
    provider: string;
    model?: string;
    tools: string[];
    permissions: Record<string, unknown>;
    timezone?: string;
    system_context?: { instructions?: string };
  };
  response: null | {
    messages: Array<{ text: string }>;
    files: unknown[];
    tool_calls: unknown[];
    status: 'complete' | 'blocked' | 'failed';
    usage: Record<string, unknown>;
  };
  state: {
    annotations: Record<string, unknown>;
    previous_hook_results: AgentHookResult[];
  };
}

export interface AgentHookResult {
  schema_version?: 'agent-hook-result.v1';
  status: AgentHookStatus;
  reason?: string;
  mutations?: {
    request?: { prompt?: string; metadata?: Record<string, unknown> };
    runtime?: { system_context?: { instructions?: string }; metadata?: Record<string, unknown> };
    response?: { text?: string; metadata?: Record<string, unknown> };
    metadata?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
  audit?: {
    summary?: string;
    redactions?: unknown[];
  };
  retry?: {
    prompt?: string;
    max_attempts?: number;
  };
}

export interface AgentHookRunAudit {
  id: string;
  phase: AgentHookPhase;
  priority: number;
  status: AgentHookStatus | 'error';
  reason?: string;
  duration_ms: number;
  error?: string;
  mutation_summary?: string[];
  at: string;
}

interface HookChainState {
  annotations: Record<string, unknown>;
  previousResults: AgentHookResult[];
  audits: AgentHookRunAudit[];
}

export interface BeforeAgentCallInput {
  hooks: AgentHooksConfig | undefined;
  messages: MessageInRow[];
  prompt: string;
  routing: RoutingContext;
  providerName: string;
  cwd: string;
  systemContext?: { instructions?: string };
  agentGroupId?: string;
  agentName?: string;
  model?: string;
}

export interface BeforeAgentCallOutcome {
  status: 'continue' | 'block' | 'require_human_review';
  prompt: string;
  systemContext?: { instructions?: string };
  reason?: string;
  audits: AgentHookRunAudit[];
}

export interface AfterAgentCallInput {
  hooks: AgentHooksConfig | undefined;
  text: string;
  routing: RoutingContext;
  providerName: string;
  cwd: string;
  prompt: string;
  continuation?: string;
  agentGroupId?: string;
  agentName?: string;
  model?: string;
}

export interface AfterAgentCallOutcome {
  status: 'continue' | 'block' | 'require_human_review' | 'retry';
  text: string;
  reason?: string;
  retryPrompt?: string;
  audits: AgentHookRunAudit[];
}

export function hasAgentHooks(hooks: AgentHooksConfig | undefined, phase?: AgentHookPhase): boolean {
  if (!hooks) return false;
  if (phase) return normalizeHookList(hooks[phase]).length > 0;
  return normalizeHookList(hooks.before_agent_call).length > 0 || normalizeHookList(hooks.after_agent_call).length > 0;
}

export async function applyBeforeAgentCallHooks(input: BeforeAgentCallInput): Promise<BeforeAgentCallOutcome> {
  const chain = resolveHookChain(input.hooks, 'before_agent_call');
  if (chain.length === 0)
    return { status: 'continue', prompt: input.prompt, systemContext: input.systemContext, audits: [] };

  let prompt = input.prompt;
  let systemContext = input.systemContext;
  const state: HookChainState = { annotations: {}, previousResults: [], audits: [] };

  for (const hook of chain) {
    const context = buildHookInput({
      phase: 'before_agent_call',
      hook,
      messages: input.messages,
      prompt,
      routing: input.routing,
      providerName: input.providerName,
      cwd: input.cwd,
      systemContext,
      agentGroupId: input.agentGroupId,
      agentName: input.agentName,
      model: input.model,
      state,
      responseText: null,
    });
    const run = await executeHook(hook, context);
    state.audits.push(run.audit);
    persistHookAudit(run.audit);

    if (!run.result) {
      const action = onErrorAction(hook);
      if (action === 'continue' || action === 'skip') continue;
      return { status: action, prompt, systemContext, reason: run.audit.error ?? 'hook error', audits: state.audits };
    }

    state.previousResults.push(run.result);
    Object.assign(state.annotations, run.result.annotations ?? {});

    if (run.result.status === 'block' || run.result.status === 'require_human_review') {
      return { status: run.result.status, prompt, systemContext, reason: run.result.reason, audits: state.audits };
    }
    if (run.result.status === 'retry') {
      return {
        status: 'block',
        prompt,
        systemContext,
        reason: 'retry is not valid for before_agent_call',
        audits: state.audits,
      };
    }
    if (run.result.status === 'mutate') {
      const mutated = applyBeforeMutations(prompt, systemContext, run.result);
      prompt = mutated.prompt;
      systemContext = mutated.systemContext;
    }
  }

  return { status: 'continue', prompt, systemContext, audits: state.audits };
}

export async function applyAfterAgentCallHooks(input: AfterAgentCallInput): Promise<AfterAgentCallOutcome> {
  const chain = resolveHookChain(input.hooks, 'after_agent_call');
  if (chain.length === 0) return { status: 'continue', text: input.text, audits: [] };

  let text = input.text;
  const state: HookChainState = { annotations: {}, previousResults: [], audits: [] };

  for (const hook of chain) {
    const context = buildHookInput({
      phase: 'after_agent_call',
      hook,
      messages: [],
      prompt: input.prompt,
      routing: input.routing,
      providerName: input.providerName,
      cwd: input.cwd,
      systemContext: undefined,
      agentGroupId: input.agentGroupId,
      agentName: input.agentName,
      model: input.model,
      state,
      responseText: text,
    });
    const run = await executeHook(hook, context);
    state.audits.push(run.audit);
    persistHookAudit(run.audit);

    if (!run.result) {
      const action = onErrorAction(hook);
      if (action === 'continue' || action === 'skip') continue;
      return { status: action, text, reason: run.audit.error ?? 'hook error', audits: state.audits };
    }

    state.previousResults.push(run.result);
    Object.assign(state.annotations, run.result.annotations ?? {});

    if (run.result.status === 'block' || run.result.status === 'require_human_review') {
      return { status: run.result.status, text, reason: run.result.reason, audits: state.audits };
    }
    if (run.result.status === 'retry') {
      return {
        status: 'retry',
        text,
        reason: run.result.reason,
        retryPrompt: run.result.retry?.prompt ?? buildDefaultRetryPrompt(run.result.reason),
        audits: state.audits,
      };
    }
    if (run.result.status === 'mutate') {
      text = applyAfterMutations(text, run.result);
    }
  }

  return { status: 'continue', text, audits: state.audits };
}

function resolveHookChain(hooks: AgentHooksConfig | undefined, phase: AgentHookPhase): AgentHookDefinition[] {
  return normalizeHookList(hooks?.[phase])
    .filter((hook) => typeof hook.id === 'string' && hook.id.length > 0)
    .slice()
    .sort((a, b) => (a.priority ?? 1_000) - (b.priority ?? 1_000) || a.id.localeCompare(b.id));
}

function normalizeHookList(value: unknown): AgentHookDefinition[] {
  return Array.isArray(value) ? (value as AgentHookDefinition[]) : [];
}

function onErrorAction(hook: AgentHookDefinition): 'block' | 'continue' | 'require_human_review' | 'skip' {
  if (hook.on_error) return hook.on_error;
  return hook.required ? 'block' : 'continue';
}

async function executeHook(
  hook: AgentHookDefinition,
  input: AgentHookInput,
): Promise<{ result: AgentHookResult | null; audit: AgentHookRunAudit }> {
  const started = Date.now();
  try {
    const result = await runHookProcedure(hook, input);
    validateHookResult(result);
    return {
      result,
      audit: {
        id: hook.id,
        phase: input.phase,
        priority: hook.priority ?? 1_000,
        status: result.status,
        reason: result.reason,
        duration_ms: Date.now() - started,
        mutation_summary: summarizeMutations(result),
        at: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      result: null,
      audit: {
        id: hook.id,
        phase: input.phase,
        priority: hook.priority ?? 1_000,
        status: 'error',
        reason: 'hook execution failed',
        duration_ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      },
    };
  }
}

async function runHookProcedure(hook: AgentHookDefinition, input: AgentHookInput): Promise<AgentHookResult> {
  if (hook.runtime === 'builtin') return runBuiltinHook(hook, input);
  if (hook.runtime === 'command') return runCommandHook(hook, input);
  throw new Error(`unsupported hook runtime: ${(hook as { runtime?: string }).runtime}`);
}

function runBuiltinHook(hook: AgentHookDefinition, input: AgentHookInput): AgentHookResult {
  switch (hook.procedure) {
    case 'regex_redact':
      return regexRedact(hook, input);
    case 'schema_validate':
      return schemaValidate(hook, input);
    case 'caller_allowlist':
      return callerAllowlist(hook, input);
    case 'jsonpath_assert':
      return jsonpathAssert(hook, input);
    default:
      throw new Error(`unsupported builtin hook procedure: ${hook.procedure ?? '(missing)'}`);
  }
}

async function runCommandHook(hook: AgentHookDefinition, input: AgentHookInput): Promise<AgentHookResult> {
  if (
    !Array.isArray(hook.command) ||
    hook.command.length === 0 ||
    hook.command.some((part) => typeof part !== 'string')
  ) {
    throw new Error('command hook requires a non-empty string[] command');
  }

  const [command, ...args] = hook.command;
  const timeout = positiveNumber(hook.timeout_ms, DEFAULT_TIMEOUT_MS);
  const maxBuffer = positiveNumber(
    (hook.config?.max_buffer_bytes as number | undefined) ?? undefined,
    DEFAULT_MAX_BUFFER,
  );
  const cwd = resolveCommandCwd(hook.config?.cwd);

  touchHeartbeat();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(command, args, { timeout, maxBuffer, cwd, env: process.env }, (error, out, stderr) => {
      if (stderr) console.error(`[agent-hook:${hook.id}] stderr: ${stderr.slice(0, 500)}`);
      if (error) return reject(error);
      resolve(out);
    });
    child.stdin?.end(`${JSON.stringify(input)}\n`);
  });
  touchHeartbeat();

  const lastLine = stdout.trim().split('\n').filter(Boolean).at(-1);
  if (!lastLine) throw new Error('command hook produced no JSON output');
  return JSON.parse(lastLine) as AgentHookResult;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveCommandCwd(value: unknown): string {
  if (typeof value !== 'string' || !value) return '/workspace/agent';
  const resolved = path.resolve(value);
  if (!resolved.startsWith('/workspace/')) throw new Error(`command hook cwd outside /workspace: ${value}`);
  return resolved;
}

function validateHookResult(result: AgentHookResult): void {
  const statuses = new Set(['continue', 'noop', 'mutate', 'block', 'retry', 'require_human_review']);
  if (!result || typeof result !== 'object') throw new Error('hook result must be an object');
  if (!statuses.has(result.status)) throw new Error(`invalid hook status: ${(result as { status?: string }).status}`);
  if (result.mutations !== undefined && (typeof result.mutations !== 'object' || result.mutations === null)) {
    throw new Error('hook mutations must be an object');
  }
}

function applyBeforeMutations(
  prompt: string,
  systemContext: { instructions?: string } | undefined,
  result: AgentHookResult,
): { prompt: string; systemContext?: { instructions?: string } } {
  let nextPrompt = prompt;
  let nextSystemContext = systemContext;
  const request = result.mutations?.request;
  if (typeof request?.prompt === 'string') nextPrompt = request.prompt;
  const runtimeSystemContext = result.mutations?.runtime?.system_context;
  if (runtimeSystemContext && typeof runtimeSystemContext.instructions === 'string') {
    nextSystemContext = { ...(nextSystemContext ?? {}), instructions: runtimeSystemContext.instructions };
  }
  return { prompt: nextPrompt, systemContext: nextSystemContext };
}

function applyAfterMutations(text: string, result: AgentHookResult): string {
  const responseText = result.mutations?.response?.text;
  return typeof responseText === 'string' ? responseText : text;
}

function summarizeMutations(result: AgentHookResult): string[] {
  const summary: string[] = [];
  if (result.mutations?.request?.prompt !== undefined) summary.push('request.prompt');
  if (result.mutations?.runtime?.system_context?.instructions !== undefined)
    summary.push('runtime.system_context.instructions');
  if (result.mutations?.response?.text !== undefined) summary.push('response.text');
  if (result.mutations?.metadata !== undefined) summary.push('metadata');
  return summary;
}

function buildHookInput(args: {
  phase: AgentHookPhase;
  hook: AgentHookDefinition;
  messages: MessageInRow[];
  prompt: string;
  routing: RoutingContext;
  providerName: string;
  cwd: string;
  systemContext?: { instructions?: string };
  agentGroupId?: string;
  agentName?: string;
  model?: string;
  state: HookChainState;
  responseText: string | null;
}): AgentHookInput {
  const first = args.messages[0];
  const content = first ? parseObject(first.content) : undefined;
  return {
    schema_version: 'agent-hook.v1',
    phase: args.phase,
    hook: { id: args.hook.id, scope: 'group' },
    call: {
      id: buildCallId(args.phase, args.messages, args.routing, args.responseText),
      agent_group_id: args.agentGroupId,
      agent_name: args.agentName,
      destination: args.routing.platformId,
      trigger: args.routing.taskRun ? 'task' : 'message',
      created_at: first?.timestamp ?? new Date().toISOString(),
    },
    actor: inferActor(first?.kind, content),
    request: {
      messages: args.messages.map((m) => ({
        id: m.id,
        kind: m.kind,
        timestamp: m.timestamp,
        platform_id: m.platform_id,
        channel_type: m.channel_type,
        thread_id: m.thread_id,
        content: parseObject(m.content) ?? m.content,
      })),
      prompt: args.prompt,
      attachments: [],
      metadata: { cwd: args.cwd },
    },
    runtime: {
      provider: args.providerName,
      model: args.model,
      tools: [],
      permissions: {},
      timezone: process.env.TZ,
      system_context: args.systemContext,
    },
    response:
      args.responseText === null
        ? null
        : {
            messages: [{ text: args.responseText }],
            files: [],
            tool_calls: [],
            status: 'complete',
            usage: {},
          },
    state: {
      annotations: args.state.annotations,
      previous_hook_results: args.state.previousResults,
    },
  };
}

function inferActor(kind: string | undefined, content: Record<string, unknown> | undefined): AgentHookInput['actor'] {
  if (kind === 'task') return { kind: 'task', id: stringOrUndefined(content?.taskId), display_name: 'task' };
  if (kind === 'system') return { kind: 'system', display_name: 'system' };
  const sender = stringOrUndefined(content?.sender);
  return { kind: 'user', id: sender, display_name: sender };
}

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildCallId(
  phase: AgentHookPhase,
  messages: MessageInRow[],
  routing: RoutingContext,
  responseText: string | null,
): string {
  const ids = messages.map((m) => m.id).join(',') || routing.inReplyTo || 'no-message';
  const suffix = responseText === null ? '' : `:${responseText.length}`;
  return `${phase}:${ids}${suffix}`;
}

function regexRedact(hook: AgentHookDefinition, input: AgentHookInput): AgentHookResult {
  const patterns = Array.isArray(hook.config?.patterns) ? hook.config.patterns : [];
  let redactions = 0;
  const redact = (text: string): string => {
    let next = text;
    for (const pattern of patterns) {
      if (!pattern || typeof pattern !== 'object') continue;
      const { regex, replacement } = pattern as { regex?: unknown; replacement?: unknown };
      if (typeof regex !== 'string') continue;
      const flags =
        typeof (pattern as { flags?: unknown }).flags === 'string' ? (pattern as { flags: string }).flags : '';
      const re = buildRegex(regex, flags);
      next = next.replace(re, () => {
        redactions += 1;
        return typeof replacement === 'string' ? replacement : '[REDACTED]';
      });
    }
    return next;
  };

  if (input.phase === 'before_agent_call') {
    const prompt = redact(input.request.prompt);
    if (prompt === input.request.prompt)
      return { status: 'noop', reason: 'no matches', audit: { summary: 'no redactions' } };
    return {
      status: 'mutate',
      reason: `redacted ${redactions} match(es)`,
      mutations: { request: { prompt } },
      audit: { summary: `redacted ${redactions} prompt match(es)` },
    };
  }

  const text = input.response?.messages[0]?.text ?? '';
  const next = redact(text);
  if (next === text) return { status: 'noop', reason: 'no matches', audit: { summary: 'no redactions' } };
  return {
    status: 'mutate',
    reason: `redacted ${redactions} match(es)`,
    mutations: { response: { text: next } },
    audit: { summary: `redacted ${redactions} response match(es)` },
  };
}

function buildRegex(source: string, configuredFlags: string): RegExp {
  let pattern = source;
  let flags = configuredFlags;
  if (pattern.startsWith('(?i)')) {
    pattern = pattern.slice(4);
    flags += 'i';
  }
  if (!flags.includes('g')) flags += 'g';
  return new RegExp(pattern, [...new Set(flags.split(''))].join(''));
}

function schemaValidate(hook: AgentHookDefinition, input: AgentHookInput): AgentHookResult {
  const requiredFields = asStringArray(hook.config?.required_fields);
  const requiredSubstrings = asStringArray(hook.config?.required_substrings);
  const target = input.phase === 'after_agent_call' ? (input.response?.messages[0]?.text ?? '') : input.request.prompt;
  const missing: string[] = [];

  if (requiredFields.length > 0) {
    const parsed = parseObject(target);
    if (parsed) {
      for (const field of requiredFields) if (!(field in parsed)) missing.push(field);
    } else {
      for (const field of requiredFields) if (!target.includes(field)) missing.push(field);
    }
  }
  for (const substring of requiredSubstrings) if (!target.includes(substring)) missing.push(substring);

  if (missing.length > 0) {
    return { status: 'block', reason: `schema validation failed; missing: ${missing.join(', ')}` };
  }
  return { status: 'continue', reason: 'schema validation passed' };
}

function callerAllowlist(hook: AgentHookDefinition, input: AgentHookInput): AgentHookResult {
  const allowed = new Set(asStringArray(hook.config?.allowed_from));
  if (allowed.size === 0) return { status: 'continue', reason: 'no allowlist configured' };
  const candidates = [input.actor?.id, input.actor?.display_name, input.actor?.kind].filter(Boolean) as string[];
  if (candidates.some((candidate) => allowed.has(candidate))) return { status: 'continue', reason: 'caller allowed' };
  return { status: 'block', reason: 'caller not allowlisted' };
}

function jsonpathAssert(hook: AgentHookDefinition, input: AgentHookInput): AgentHookResult {
  const pathValue = typeof hook.config?.path === 'string' ? hook.config.path : '';
  if (!pathValue.startsWith('$.')) throw new Error('jsonpath_assert supports simple $.field paths only');
  const expected = hook.config?.equals;
  const source = hook.config?.source === 'response' ? input.response : input;
  const actual = getSimplePath(source as unknown, pathValue.slice(2).split('.'));
  if (expected !== undefined ? actual === expected : actual !== undefined) {
    return { status: 'continue', reason: 'jsonpath assertion passed' };
  }
  return { status: 'block', reason: `jsonpath assertion failed: ${pathValue}` };
}

function getSimplePath(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function buildDefaultRetryPrompt(reason: string | undefined): string {
  return `<system>Your previous response did not pass deterministic post-call validation${reason ? `: ${escapeXml(reason)}` : ''}. Please retry with a corrected final answer.</system>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function persistHookAudit(audit: AgentHookRunAudit): void {
  try {
    const db = getOutboundDb();
    const existing = db.prepare('SELECT value FROM session_state WHERE key = ?').get(HOOK_AUDIT_KEY) as
      | { value: string }
      | undefined;
    const runs = existing ? (JSON.parse(existing.value) as AgentHookRunAudit[]) : [];
    runs.push(audit);
    const trimmed = runs.slice(-MAX_AUDIT_RUNS);
    db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      HOOK_AUDIT_KEY,
      JSON.stringify(trimmed),
      new Date().toISOString(),
    );
  } catch (err) {
    console.error(`[agent-hook] audit persistence failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
