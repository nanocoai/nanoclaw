/**
 * Google Gemini CLI provider — wraps `gemini` CLI via ACP JSON-RPC.
 */
import fs from 'fs';
import path from 'path';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import {
  type AppServer,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
  attachGeminiAutoApproval,
  initializeGeminiAppServer,
  killGeminiAppServer,
  spawnGeminiAppServer,
  startGeminiTurn,
  startOrResumeGeminiSession,
  writeGeminiMcpConfigToml,
} from './gemini-app-server.js';

/** Hard ceiling for a single turn. Guards against app-server wedging. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

const STALE_SESSION_RE = /session\s+not\s+found|unknown\s+session|session[_\s]id|no such session/i;

// ── System-prompt assembly ──────────────────────────────────────────────────

/**
 * Inline `@<path>` import directives (line-anchored) with the contents of
 * the referenced file, resolved relative to `baseDir`.
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

export class GeminiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private readonly mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  private readonly model: string;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    // 'auto' is the Gemini CLI recommended default, resolving to the best
    // available model (typically Gemini 3 Pro). Other valid values include
    // 'pro', 'flash', and specific versions like 'gemini-3-pro-preview'.
    this.model = (options.env?.GEMINI_MODEL as string | undefined) ?? 'auto';
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
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
      writeGeminiMcpConfigToml(self.mcpServers);
      const server = spawnGeminiAppServer();
      attachGeminiAutoApproval(server);

      let sessionId: string | undefined = input.continuation;
      let initYielded = false;

      try {
        await initializeGeminiAppServer(server);

        const threadParams = {
          model: self.model,
          cwd: input.cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          personality: 'friendly',
          baseInstructions: composeBaseInstructions(input.systemContext?.instructions),
        };

        sessionId = await startOrResumeGeminiSession(server, sessionId, threadParams);

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

          yield* runOneTurn(
            server,
            sessionId!,
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
        killGeminiAppServer(server);
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

async function* runOneTurn(
  server: AppServer,
  sessionId: string,
  inputText: string,
  model: string,
  cwd: string,
  hasInit: () => boolean,
  markInit: () => void,
): AsyncGenerator<ProviderEvent> {
  const turnState: { error: Error | null } = { error: null };
  let resultText = '';
  let turnDone = false;

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

    if (method === 'session/update' && params.sessionId === sessionId) {
      // Any progress update (chunks, status changes) means the tool that was
      // in flight is either done or has produced output, so we clear the
      // stuck tolerance.
      clearContainerToolInFlight();

      const update = params.update as any;
      if (update.sessionUpdate === 'agent_message_chunk') {
        const chunk = update.content?.text;
        if (chunk) {
          resultText += chunk;
        }
      } else if (update.sessionUpdate === 'agent_thought_chunk') {
        const thought = update.content?.text;
        if (thought) {
          buffer.push({ type: 'progress', message: thought });
        }
      } else if (update.sessionUpdate === 'status_changed') {
        const status = update.status;
        if (status) {
          buffer.push({ type: 'progress', message: `status: ${status}` });
        }
      }
    } else if (method === 'assistant/message_delta' || method === 'tool/call') {
      // Official ACP event names.
      // Every inbound update from the assistant also clears stuck tolerance.
      clearContainerToolInFlight();

      if (method === 'assistant/message_delta') {
        const delta = params.delta as string;
        if (delta) resultText += delta;
      }
    }

    kick();
  };

  const approvalHandler = (req: JsonRpcServerRequest): void => {
    if (req.method === 'item/commandExecution/requestApproval') {
      const p = req.params as { command?: string; timeout?: number };
      setContainerToolInFlight('Bash', p.timeout ?? null);
    }
  };

  server.notificationHandlers.push(handler);
  server.serverRequestHandlers.push(approvalHandler);

  const timer = setTimeout(() => {
    turnState.error = new Error(`Turn timed out after ${TURN_TIMEOUT_MS}ms`);
    turnDone = true;
    kick();
  }, TURN_TIMEOUT_MS);

  try {
    if (!hasInit()) {
      markInit();
      buffer.push({ type: 'init', continuation: sessionId });
    }

    // ACP session/prompt resolves when the turn completes
    startGeminiTurn(server, { sessionId, inputText, model, cwd })
      .then(() => {
        turnDone = true;
        kick();
      })
      .catch((err) => {
        turnState.error = err;
        turnDone = true;
        kick();
      });

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
    clearContainerToolInFlight();
    const idx = server.notificationHandlers.indexOf(handler);
    if (idx >= 0) server.notificationHandlers.splice(idx, 1);
    const aidx = server.serverRequestHandlers.indexOf(approvalHandler);
    if (aidx >= 0) server.serverRequestHandlers.splice(aidx, 1);
  }
}


registerProvider('gemini', (opts) => new GeminiProvider(opts));
