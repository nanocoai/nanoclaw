/**
 * OpenAI Codex provider — wraps `codex app-server` via JSON-RPC.
 *
 * Unlike the (deprecated) @openai/codex-sdk approach, the app-server
 * protocol exposes proper session/stream semantics, native compaction, and
 * stable MCP config via ~/.codex/config.toml — which is the same mechanism
 * the standalone codex CLI uses, so the container and host share one
 * provider-integration story.
 *
 * Codex turns don't accept mid-turn input. Follow-up `push()` messages are
 * queued and drained after the current turn completes (same pattern as the
 * opencode provider — see poll-loop for why that's correct: the poll-loop
 * only pushes once it has new pending messages, and we only drain between
 * turns, so no message is dropped).
 */
import fs from 'fs';
import path from 'path';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import {
  type AppServer,
  type JsonRpcNotification,
  STALE_THREAD_RE,
  attachCodexAutoApproval,
  createCodexConfigOverrides,
  initializeCodexAppServer,
  killCodexAppServer,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  writeCodexMcpConfigToml,
} from './codex-app-server.js';

/** Hard ceiling for a single turn. Guards against app-server wedging. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

// ── System-prompt assembly ──────────────────────────────────────────────────
// Codex's app-server doesn't expand Claude Code's `@-import` syntax in
// CLAUDE.md, and doesn't auto-load CLAUDE.local.md from the working dir the
// way Claude Code does. Left alone, the agent sees only the raw import
// directives as literal text and none of the composed content — no shared
// CLAUDE.md, no module fragments, no per-group memory. We resolve both here
// so Codex (and any other non-Claude provider) gets the same effective
// system prompt the Claude provider gets natively.

/**
 * Inline `@<path>` import directives (line-anchored) with the contents of
 * the referenced file, resolved relative to `baseDir`. Recurses so imports
 * within imported files expand too. Cycles and missing files are silently
 * dropped (replaced with empty text) rather than left as raw `@path` lines,
 * which would confuse the model.
 */
export function resolveClaudeImports(content: string, baseDir: string, seen: Set<string> = new Set()): string {
  return content.replace(/^@(\S+)\s*$/gm, (_match, importPath: string) => {
    try {
      const resolved = path.resolve(baseDir, importPath);
      if (seen.has(resolved)) return '';
      if (!fs.existsSync(resolved)) return '';
      const nextSeen = new Set(seen);
      nextSeen.add(resolved);
      const imported = fs.readFileSync(resolved, 'utf-8');
      return resolveClaudeImports(imported, path.dirname(resolved), nextSeen);
    } catch {
      return '';
    }
  });
}

function readAgentAndGlobalClaudeMd(): string | undefined {
  // Per-group CLAUDE.md is responsible for pulling in the global instructions
  // if the group wants them (the default scaffold starts with
  // `@./.claude-global.md` which resolveClaudeImports inlines). Appending
  // `/workspace/global/CLAUDE.md` explicitly here would double-inline the
  // global content for any non-main group, wasting context tokens and
  // risking contradictory instructions. Groups that don't import global
  // intentionally don't get it — same as Claude-backed agents.
  const groupDir = '/workspace/agent';
  const groupPath = `${groupDir}/CLAUDE.md`;
  const localPath = `${groupDir}/CLAUDE.local.md`;
  const parts: string[] = [];

  if (fs.existsSync(groupPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(groupPath, 'utf-8'), groupDir));
  }
  if (fs.existsSync(localPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(localPath, 'utf-8'), groupDir));
  }

  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

function composeBaseInstructions(promptAddendum: string | undefined): string | undefined {
  const claudeMd = readAgentAndGlobalClaudeMd();
  const pieces = [claudeMd, promptAddendum].filter((s): s is string => Boolean(s));
  return pieces.length > 0 ? pieces.join('\n\n---\n\n') : undefined;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  private readonly model: string;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    this.model = (options.env?.CODEX_MODEL as string | undefined) ?? 'gpt-5.4-mini';
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_THREAD_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const kick = (): void => {
      waiting?.();
    };

    pending.push(input.prompt);

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      // One app-server per query invocation. The poll-loop keeps a single
      // query active per batch of pending messages and ends it on idle, so
      // spawn-per-query matches that cadence naturally.
      writeCodexMcpConfigToml(self.mcpServers);
      const server = spawnCodexAppServer(createCodexConfigOverrides());
      attachCodexAutoApproval(server);

      let threadId: string | undefined = input.continuation;
      let initYielded = false;

      try {
        await initializeCodexAppServer(server);

        const threadParams = {
          model: self.model,
          cwd: input.cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          personality: 'friendly',
          baseInstructions: composeBaseInstructions(input.systemContext?.instructions),
        };

        threadId = await startOrResumeCodexThread(server, threadId, threadParams);

        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
          }
          if (aborted) return;
          if (pending.length === 0 && ended) return;

          const text = pending.shift()!;

          // One turn = one channel of streaming events. Each notification
          // from the app-server yields an `activity` first (so the
          // poll-loop's idle timer stays honest) and then, where relevant,
          // an init / result / progress event.
          yield* runOneTurn(
            server,
            threadId!,
            text,
            self.model,
            input.cwd,
            () => initYielded,
            () => {
              initYielded = true;
            },
          );
        }
      } finally {
        killCodexAppServer(server);
      }
    }

    return {
      push: (message: string) => {
        pending.push(message);
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      abort: () => {
        aborted = true;
        kick();
      },
      events: gen(),
    };
  }
}

// ── Per-turn event pump ─────────────────────────────────────────────────────
// Pulled out because the gen() loop above reads cleaner with it extracted,
// and because it's a natural seam for future unit tests that drive it with
// a fake notification stream.

async function* runOneTurn(
  server: AppServer,
  threadId: string,
  inputText: string,
  model: string,
  cwd: string,
  hasInit: () => boolean,
  markInit: () => void,
): AsyncGenerator<ProviderEvent> {
  // Mutable refs via object properties — TS can't track closure assignments
  // for narrowing, but property access keeps the declared type visible.
  const turnState: { error: Error | null } = { error: null };
  let resultText = '';
  let turnDone = false;

  // Buffered event queue so we can `yield` across the async notification
  // callback. Each notification pushes zero or more ProviderEvents; the
  // generator drains the buffer.
  const buffer: ProviderEvent[] = [];
  let waker: (() => void) | null = null;
  const kick = (): void => {
    waker?.();
    waker = null;
  };

  const handler = (n: JsonRpcNotification): void => {
    const method = n.method;
    const params = n.params;

    // Every inbound notification counts as activity for the poll-loop's
    // idle timer — yield before any event-specific translation so even
    // long tool executions keep the loop awake.
    buffer.push({ type: 'activity' });

    switch (method) {
      case 'thread/started': {
        const thread = params.thread as { id?: string } | undefined;
        if (thread?.id && !hasInit()) {
          markInit();
          buffer.push({ type: 'init', continuation: thread.id });
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = params.delta as string;
        if (delta) resultText += delta;
        break;
      }
      case 'item/completed': {
        const item = params.item as { type?: string; text?: string } | undefined;
        if (item?.type === 'agentMessage' && item.text) resultText = item.text;
        break;
      }
      case 'turn/completed':
        turnDone = true;
        break;
      case 'turn/failed': {
        const e = params.error as { message?: string } | undefined;
        turnState.error = new Error(e?.message || 'Turn failed');
        turnDone = true;
        break;
      }
      case 'thread/status/changed': {
        const status = params.status as string | undefined;
        if (status) buffer.push({ type: 'progress', message: `status: ${status}` });
        break;
      }
      default:
        // Silently handle the many item/* notifications — they already
        // contributed an activity event above.
        break;
    }

    kick();
  };

  server.notificationHandlers.push(handler);

  const timer = setTimeout(() => {
    turnState.error = new Error(`Turn timed out after ${TURN_TIMEOUT_MS}ms`);
    turnDone = true;
    kick();
  }, TURN_TIMEOUT_MS);

  try {
    // If we yield init before turn/start, the poll-loop stores
    // continuation early and survives a mid-turn crash.
    if (!hasInit()) {
      markInit();
      buffer.push({ type: 'init', continuation: threadId });
    }

    await startCodexTurn(server, { threadId, inputText, model, cwd });

    while (true) {
      while (buffer.length > 0) {
        const ev = buffer.shift()!;
        yield ev;
      }
      if (turnDone) break;
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
      waker = null;
    }

    while (buffer.length > 0) yield buffer.shift()!;

    if (turnState.error) {
      yield { type: 'error', message: turnState.error.message, retryable: false };
      return;
    }

    yield { type: 'result', text: resultText || null };
  } finally {
    clearTimeout(timer);
    const idx = server.notificationHandlers.indexOf(handler);
    if (idx >= 0) server.notificationHandlers.splice(idx, 1);
  }
}

registerProvider('codex', (opts) => new CodexProvider(opts));
