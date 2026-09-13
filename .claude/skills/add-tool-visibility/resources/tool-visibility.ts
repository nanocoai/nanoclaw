/**
 * Live tool-use visibility — emits chat messages describing each tool
 * call as the agent runs. Ported from v1 (`container/agent-runner/src/index.ts`
 * tool-hooks block) onto v2's outbound DB + Bun runtime.
 *
 * Strategy:
 *   PreToolUse  → "🔧 label: short description"
 *   PostToolUse → "✓ Xs" (only for slow Bash, > 3s)
 *
 * Rapid file I/O (Read/Write/Edit/WebFetch) is debounced 300ms and coalesced
 * into a single "×N" message to prevent chat spam. Noisy tools (WebSearch,
 * Glob, Grep) are skipped entirely.
 *
 * Messages are written to outbound.db via writeMessageOut() with routing
 * pulled from session_routing (default reply lane). The host's delivery
 * loop picks them up and sends them through the same channel adapter the
 * rest of the chat goes through. Content is marked `_toolVis: true` so a
 * host bridge that supports edit-in-place can accumulate lines into one
 * bubble (optional; without that support each line is a normal chat send).
 */
import path from 'path';

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { getInboundDb, getOutboundDb } from '../db/connection.js';

// Detect whether this agent turn was triggered by a scheduled-task wake-up
// (vs. an interactive chat message). Scheduled tasks often run with explicit
// silent-on-OK behavior — leaking tool-call previews to chat creates orphan-
// notification noise without context.
//
// Classify on THIS turn's batch, not the global-latest inbound row. The old
// `ORDER BY seq DESC LIMIT 1` flipped an in-progress *chat* turn to silent
// whenever a cron task happened to land in inbound mid-turn — suppressing all
// tool-vis for that reply. The current turn's messages are recorded in
// outbound.db's `processing_ack` (status='processing') by markProcessing(); a
// freshly-inserted cron task is still 'pending' (next poll) and is NOT in this
// batch. We suppress only when the in-flight batch is non-empty and contains
// NO interactive chat message — i.e. a genuine task-only wake. Re-queried
// every call (no cache): a single container handles both chat and task wakes.
function isTaskSession(): boolean {
  try {
    const acks = getOutboundDb()
      .prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'")
      .all() as Array<{ message_id: string }>;
    if (acks.length === 0) return false; // nothing in-flight → treat as interactive
    const ids = acks.map((a) => a.message_id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = getInboundDb()
      .prepare(`SELECT kind FROM messages_in WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ kind?: string }>;
    if (rows.length === 0) return false;
    // Any non-task (chat) message in the batch → interactive turn → show tool-vis.
    const hasChat = rows.some((r) => r.kind && r.kind !== 'task');
    return !hasChat;
  } catch {
    return false;
  }
}

const SKIP_TOOLS = new Set(['WebSearch', 'Glob', 'Grep']);

const MAX_INPUT_PREVIEW = 80;
const LONG_CALL_THRESHOLD_MS = 3000;
const PROGRESS_FIRST_DELAY_MS = 30000;  // first progress msg at 30s
const PROGRESS_INTERVAL_MS = 30000;     // then every 30s

const TOOL_EMOJI: Record<string, string> = {
  Bash: '🖥️',
  Read: '📖',
  Write: '✍️',
  Edit: '✏️',
  MultiEdit: '✏️',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Agent: '🤖',
  Task: '🤖',
  TodoWrite: '📝',
  Skill: '📚',
};

const TOOL_LABEL: Record<string, string> = {
  Bash: 'bash',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  WebFetch: 'fetch',
  WebSearch: 'search',
  Agent: 'agent',
  Task: 'task',
  TodoWrite: 'todo',
  Skill: 'skill',
};

const BATCH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'WebFetch']);

const BASH_WITH_SUBCOMMAND = new Set([
  'git', 'npm', 'pnpm', 'bun', 'apt', 'apt-get', 'pip', 'pip3',
  'systemctl', 'docker', 'yarn', 'uv', 'gh', 'ssh',
]);

function log(msg: string): void {
  console.error(`[tool-visibility] ${msg}`);
}

// Never cut inside a UTF-16 surrogate pair — a preview ending in half an
// emoji is invalid UTF-8 and makes some chat backends reject the whole
// tool-vis bubble (and, via a pre-send flush, every later real message on
// that chat).
export function safeSlice(s: string, n: number): string {
  const cut = s.slice(0, n);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function truncate(s: string): string {
  return s.length > MAX_INPUT_PREVIEW ? safeSlice(s, MAX_INPUT_PREVIEW) + '…' : s;
}

/** Extract domain from URL — keeps preview compact ("github.com" not full URL). */
function domainOf(url: string): string {
  return url.replace(/^https?:\/\//, '').split('/')[0];
}

/** Shorten long file paths from the start with an ellipsis prefix. */
function shortPath(p: string, maxLen = 35): string {
  if (p.length <= maxLen) return p;
  return '…' + p.slice(-(maxLen - 1));
}

/** Format a tool message with verb-aligned label for easier scanning. */
function formatToolLine(emoji: string, label: string, desc: string, count = 0): string {
  const countStr = count > 1 ? ` ×${count}` : '';
  if (!label) {
    return desc ? `${emoji}${countStr}  ${desc}` : `${emoji}${countStr}`;
  }
  // Pad label so descriptions align vertically across tool calls.
  const paddedLabel = label.padEnd(8);
  return desc ? `${emoji} ${paddedLabel}${countStr} ${desc}`.trimEnd()
              : `${emoji} ${paddedLabel.trimEnd()}${countStr}`;
}

/**
 * Try to extract a string output from a tool_response of unknown shape.
 * Returns null if nothing string-y is found.
 */
function extractResponseText(toolResponse: unknown): string | null {
  if (toolResponse == null) return null;
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse === 'object') {
    const r = toolResponse as Record<string, unknown>;
    if (typeof r.output === 'string') return r.output;
    if (typeof r.text === 'string') return r.text;
    if (typeof r.content === 'string') return r.content;
    if (typeof r.stdout === 'string') return r.stdout;
  }
  return null;
}

/**
 * Compact post-completion result hint — line counts, response sizes, exit codes.
 * Returns null when there's nothing interesting to add (avoids chat spam).
 */
function resultShape(toolName: string, toolResponse: unknown): string | null {
  const text = extractResponseText(toolResponse);
  if (toolName === 'Read' && text) {
    const lines = text.split('\n').length;
    return `${lines} lines`;
  }
  if (toolName === 'Bash' && text) {
    const allLines = text.split('\n');
    const nonEmpty = allLines.filter((l) => l.trim()).length;
    if (nonEmpty < 1) return null;
    // Show first non-empty line as a sneak-peek; useful confirmation that
    // the command actually produced what was expected. Trim to keep the
    // chat-line compact.
    const firstLine = allLines.find((l) => l.trim()) || '';
    const peek = safeSlice(firstLine.replace(/\s+/g, ' ').trim(), 60);
    if (nonEmpty >= 5) {
      return peek ? `${nonEmpty} lines → ${peek}` : `${nonEmpty} lines`;
    }
    if (peek) return `→ ${peek}`;
    return null;
  }
  if (toolName === 'WebFetch' && text) {
    const kb = Math.round(text.length / 1024);
    if (kb >= 1) return `${kb}KB`;
    return null;
  }
  return null;
}

/**
 * Heuristic failure detection from a normal PostToolUse response. Some tools
 * report errors via the response payload rather than throwing — this catches
 * those so we still emit the ❌ marker.
 */
function detectFailureFromResponse(_toolName: string, toolResponse: unknown): string | null {
  if (toolResponse == null) return null;
  if (typeof toolResponse === 'object') {
    const r = toolResponse as Record<string, unknown>;
    if (r.is_error === true || r.success === false) {
      const explicit = typeof r.error === 'string' ? r.error
        : typeof r.message === 'string' ? r.message
        : 'failed';
      return safeSlice(explicit.replace(/\s+/g, ' ').trim(), 80);
    }
    if (typeof r.error === 'string' && r.error.trim()) {
      return safeSlice(r.error.replace(/\s+/g, ' ').trim(), 80);
    }
  }
  const text = extractResponseText(toolResponse);
  if (!text) return null;
  // Pattern-based fallback. Conservative — only flag clear failures.
  const patterns: RegExp[] = [
    /^(Error|ERROR): (.+)$/m,
    /(permission denied)/i,
    /(no such file or directory)/i,
    /(command not found)/i,
    /(Traceback \(most recent call last\))/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return safeSlice(m[0].replace(/\s+/g, ' ').trim(), 80);
  }
  return null;
}

/** Collapse a heredoc into its interpreter, marker, and first useful line. */
export function summarizeHeredoc(cmd: string): string {
  const match = cmd.match(/((?:[\w./-]+\s+)*)((?:python3?|bash|sh|node|ruby|perl)\S*)\s+<<-?\s*['"]?(\w+)['"]?/i);
  if (!match) return cmd;
  const interpreter = path.basename(match[2]);
  const tag = match[3];
  const body = cmd.slice(match[0].length);
  const firstUseful =
    body
      .split(/\n|;/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#') && line !== tag) ?? '';
  const hint = firstUseful ? safeSlice(firstUseful.replace(/\s+/g, ' '), 40) : tag;
  return `${interpreter} «${tag}» ${hint}…`;
}

/** Extract the meaningful part of a bash command for the preview. */
export function summarizeBash(raw: string): string {
  const cmd = summarizeHeredoc(raw.trim()).replace(/\s+/g, ' ').trim();

  // Split into segments by command connectors and skip ones that are pure
  // variable-assignment blocks (e.g. `SSH_CMD="ssh -i key"` before
  // `&& $SSH_CMD host "ls"`). Without this, long wrapper assignments at the
  // start eat the whole preview.
  const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).map(s => s.trim()).filter(Boolean);
  const isPureAssignment = (s: string) =>
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*)+$/.test(s);
  let first = segments[0] ?? '';
  for (const seg of segments) {
    if (isPureAssignment(seg)) continue;
    // Also strip leading inline `VAR=value VAR2=value cmd ...` assignments
    first = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
    break;
  }

  const stripped = first.replace(/^sudo\s+/, '');
  const words = stripped.split(' ');
  const bin = path.basename(words[0] ?? '');
  const sub = words[1] ?? '';

  // Treat `$VAR root@host …` as ssh-like — common pattern for SSH-key-bundle aliases.
  const isSshLike = bin === 'ssh' || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(words[0] ?? '');
  if (isSshLike) {
    // Skip leading flags so we don't mistake `-i` / `-o` / etc. for the host.
    // Flags that take an argument consume the next word too.
    const sshFlagsWithArg = new Set(['-i', '-o', '-p', '-J', '-F', '-L', '-R', '-D', '-l', '-c', '-m', '-b', '-B', '-e', '-I', '-Q', '-S', '-W', '-w']);
    const sshArgs = words.slice(1);
    let idx = 0;
    while (idx < sshArgs.length) {
      const a = sshArgs[idx];
      if (sshFlagsWithArg.has(a)) {
        idx += 2;
        continue;
      }
      if (a.startsWith('-')) {
        idx += 1;
        continue;
      }
      break;
    }
    const host = sshArgs[idx];
    if (host) {
      const afterHost = sshArgs.slice(idx + 1).join(' ');
      const remoteCmd = afterHost.replace(/^["']|["']$/g, '').trim();
      return truncate(remoteCmd ? `ssh ${host}: ${remoteCmd}` : `ssh ${host}`);
    }
    return truncate(first);
  }
  if (BASH_WITH_SUBCOMMAND.has(bin) && sub && !sub.startsWith('-')) {
    return truncate(`${bin} ${sub}`);
  }
  if ((bin === 'bash' || bin === 'sh') && sub) {
    return truncate(path.basename(sub));
  }
  return truncate(first);
}

/** Human-readable summary of a tool's input. */
export function describeToolInput(toolName: string, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const input = toolInput as Record<string, unknown>;

  if (toolName === 'Bash') {
    // Prefer the human description when the SDK/tool supplies one — glances
    // better than raw launcher syntax. Fall back to command summary.
    if (typeof input.description === 'string' && input.description.trim()) {
      return truncate(input.description.replace(/\s+/g, ' ').trim());
    }
    if (typeof input.command === 'string') return `\`${summarizeBash(input.command)}\``;
    return '';
  }
  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') && typeof input.file_path === 'string') {
    return `\`${shortPath(input.file_path)}\``;
  }
  if (toolName === 'Glob' && typeof input.pattern === 'string') {
    return `\`${input.pattern}\``;
  }
  if (toolName === 'Grep' && typeof input.pattern === 'string') {
    return `\`${input.pattern}\``;
  }
  if (toolName === 'WebFetch' && typeof input.url === 'string') {
    return `\`${domainOf(input.url)}\``;
  }
  if (toolName === 'WebSearch' && typeof input.query === 'string') {
    return `\`${truncate(input.query)}\``;
  }
  if (toolName === 'Task' && typeof input.description === 'string') {
    return truncate(input.description);
  }
  if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
    const n = input.todos.length;
    return `${n} task${n === 1 ? '' : 's'}`;
  }
  if (toolName === 'Skill' && typeof input.skill === 'string') {
    return `\`${input.skill}\``;
  }

  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length > 0) {
      return truncate(val.replace(/\s+/g, ' ').trim());
    }
  }
  return '';
}

/**
 * Write a chat message through the outbound DB. Non-blocking — any failure
 * is swallowed so a broken hook can never kill the agent turn.
 */
function emit(text: string): void {
  // Scheduled-task sessions: suppress tool-vis entirely. Orphan tool-call
  // previews leak into chat without context when the agent stays silent
  // on a successful "all OK" check — pure noise to the user.
  if (isTaskSession()) return;
  try {
    const routing = getSessionRouting();
    if (!routing.channel_type || !routing.platform_id) {
      // Agent-shared or internal session with no reply lane — nothing to do.
      return;
    }
    writeMessageOut({
      id: `tv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      // Mark as tool-visibility so a host bridge can accumulate these into
      // a single edited message-bubble per thread (Telegram-style), rather
      // than sending a new notification per tool call. Bridges without
      // that support ignore the flag and deliver normally.
      content: JSON.stringify({ text, _toolVis: true }),
    });
  } catch (err) {
    log(`emit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Batching for rapid file I/O ──────────────────────────────────────

interface BatchEntry {
  emoji: string;
  label: string;
  lastDesc: string;
  count: number;
  timer: ReturnType<typeof setTimeout>;
}
const toolBatch = new Map<string, BatchEntry>();

function flushBatch(toolName: string): void {
  const entry = toolBatch.get(toolName);
  if (!entry) return;
  toolBatch.delete(toolName);
  emit(formatToolLine(entry.emoji, entry.label, entry.lastDesc, entry.count));
}

function sendBatched(toolName: string, emoji: string, label: string, desc: string): void {
  const existing = toolBatch.get(toolName);
  if (existing) {
    clearTimeout(existing.timer);
    existing.count++;
    existing.lastDesc = desc;
    existing.timer = setTimeout(() => flushBatch(toolName), 300);
  } else {
    const timer = setTimeout(() => flushBatch(toolName), 300);
    toolBatch.set(toolName, { emoji, label, lastDesc: desc, count: 1, timer });
  }
}

// ── Duration tracking for slow Bash ──────────────────────────────────

const toolStartTimes: Record<string, number> = {};
const progressTimers: Record<string, ReturnType<typeof setInterval>> = {};

// ── Hook implementations ─────────────────────────────────────────────

/**
 * Augment the existing v2 PreToolUse hook with chat visibility.
 * Call this AFTER the existing `preToolUseHook` runs (so container_state
 * still gets recorded even if visibility errors).
 */
export const preToolUseVisibility: HookCallback = async (input, toolUseId) => {
  if (isTaskSession()) return { continue: true };
  const i = input as { tool_name?: string; tool_input?: unknown; tool_use_id?: string; transcript_path?: string };
  // Skip subagent (Task/Agent) tool calls — user wants only the top-level
  // agent's activity in chat. Subagent transcripts live under `/subagents/`.
  if (typeof i.transcript_path === 'string' && i.transcript_path.includes('/subagents/')) {
    return { continue: true };
  }
  const toolName = i.tool_name ?? '';

  if (SKIP_TOOLS.has(toolName)) return { continue: true };

  const id = toolUseId || i.tool_use_id;
  if (id) toolStartTimes[id] = Date.now();

  const desc = describeToolInput(toolName, i.tool_input);
  const emoji = TOOL_EMOJI[toolName] ?? '🔧';
  // Bash rows omit the redundant "bash" label — description/command carries intent.
  const label = toolName === 'Bash' ? '' : (TOOL_LABEL[toolName] ?? toolName.toLowerCase());

  // Suppress empty TodoWrite calls (e.g. clearing stale todos).
  // `📝 todo  0 tasks` is pure noise; conveys no semantic information.
  if (toolName === 'TodoWrite') {
    const todos = (i.tool_input as { todos?: unknown[] } | undefined)?.todos;
    if (Array.isArray(todos) && todos.length === 0) return { continue: true };
  }

  if (BATCH_TOOLS.has(toolName)) {
    sendBatched(toolName, emoji, label, desc);
  } else {
    emit(formatToolLine(emoji, label, desc));
  }

  // Progress emitter for long-running Agent/Task calls — sends a
  // "still working — Xs elapsed" message every 30s while the call hasn't
  // returned. Cleared in the post-tool hook.
  if ((toolName === 'Agent' || toolName === 'Task') && id) {
    const startedAt = toolStartTimes[id] ?? Date.now();
    const tick = () => {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const elapsedStr = elapsedSec >= 60
        ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
        : `${elapsedSec}s`;
      emit(formatToolLine('⏳', label, `still working — ${elapsedStr} elapsed`));
    };
    progressTimers[id] = setInterval(tick, PROGRESS_INTERVAL_MS);
    // First tick after 30s (don't fire immediately — pre-hook line already shown)
    setTimeout(tick, PROGRESS_FIRST_DELAY_MS);
  }

  return { continue: true };
};

/**
 * Post-tool hook: only emits a completion marker for Bash calls that ran
 * longer than LONG_CALL_THRESHOLD_MS. Other tools stay silent on the way
 * out — the pre-hook message is enough signal.
 */
export const postToolUseVisibility: HookCallback = async (input, toolUseId) => {
  if (isTaskSession()) return { continue: true };
  const i = input as {
    hook_event_name?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
    error?: string;
    tool_use_id?: string;
    transcript_path?: string;
  };
  if (typeof i.transcript_path === 'string' && i.transcript_path.includes('/subagents/')) {
    return { continue: true };
  }
  const toolName = i.tool_name ?? '';

  if (SKIP_TOOLS.has(toolName)) return { continue: true };

  const id = toolUseId || i.tool_use_id;
  const startTime = id ? toolStartTimes[id] : undefined;
  if (id) delete toolStartTimes[id];

  // Clear any progress timer for Agent/Task — call is done, no more ticks.
  if (id && progressTimers[id]) {
    clearInterval(progressTimers[id]);
    delete progressTimers[id];
  }

  const desc = describeToolInput(toolName, i.tool_input);

  // FAILURE PATH 1 — explicit PostToolUseFailure event with `error` field.
  if (i.hook_event_name === 'PostToolUseFailure') {
    const reason = safeSlice((i.error ?? 'failed').replace(/\s+/g, ' ').trim(), 80);
    emit(desc ? `❌  ${desc}  · ${reason}` : `❌  ${reason}`);
    return { continue: true };
  }

  // FAILURE PATH 2 — heuristic detection from tool_response (some tools
  // report errors in their normal response payload).
  const inferred = detectFailureFromResponse(toolName, i.tool_response);
  if (inferred) {
    emit(desc ? `❌  ${desc}  · ${inferred}` : `❌  ${inferred}`);
    return { continue: true };
  }

  // SUCCESS PATH — emit done-marker for slow Bash, optionally enriched
  // with a result-shape hint (line count, first-line peek).
  if (toolName === 'Bash' && startTime) {
    const elapsed = Date.now() - startTime;
    if (elapsed > LONG_CALL_THRESHOLD_MS) {
      const shape = resultShape(toolName, i.tool_response);
      emit(`✓  ${(elapsed / 1000).toFixed(1)}s` + (shape ? ` · ${shape}` : ''));
    }
  }

  return { continue: true };
};
