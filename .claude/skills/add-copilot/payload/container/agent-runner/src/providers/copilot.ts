import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  CopilotClient,
  type CopilotClientOptions,
  type CopilotSession,
  type SessionConfig,
  type SessionEvent,
} from '@github/copilot-sdk';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { copilotMcpServers } from './copilot-mcp.js';

const STATE_DIR = '/workspace/copilot-state';
const SKILLS_DIR = '/home/node/.claude/skills';

/**
 * Non-secret stand-in for the operator's device-login token. The credential
 * gateway swaps the Authorization header on the Copilot hosts it is scoped to,
 * so the real token never enters the container. See scripts/copilot-login.ts.
 */
export const COPILOT_GATEWAY_PLACEHOLDER = 'nanoclaw-gateway-placeholder';
export function copilotClientOptions(env: Record<string, string | undefined> = process.env): CopilotClientOptions {
  return {
    mode: 'empty',
    baseDirectory: STATE_DIR,
    gitHubToken: COPILOT_GATEWAY_PLACEHOLDER,
    useLoggedInUser: false,
    env: { ...env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined },
  };
}

function copilotSessionConfig(options: ProviderOptions, input: QueryInput): SessionConfig {
  const projectInstructions = readFileSync(path.join(input.cwd, 'CLAUDE.md'), 'utf8');
  return {
    model: options.model ?? options.env?.COPILOT_MODEL ?? 'auto',
    workingDirectory: input.cwd,
    additionalDirectories: options.additionalDirectories,
    skillDirectories: [SKILLS_DIR],
    systemMessage: {
      mode: 'append',
      content: [projectInstructions, input.systemContext?.instructions].filter(Boolean).join('\n\n'),
    },
    mcpServers: copilotMcpServers(options.mcpServers),
    availableTools: ['builtin:*', 'mcp:*'],
    excludedTools: ['builtin:ask_user', 'builtin:schedule', 'builtin:send_message'],
    streaming: true,
    onPermissionRequest: (request) =>
      'managedApprovalRequired' in request && request.managedApprovalRequired
        ? { kind: 'user-not-available' }
        : { kind: 'approve-once' },
  };
}

export class CopilotProvider implements AgentProvider {
  private memoryHook?: MemorySessionHookRegistration;

  constructor(
    private readonly options: ProviderOptions = {},
    private readonly makeClient: () => CopilotClient = () => new CopilotClient(copilotClientOptions(options.env)),
  ) {}

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memoryHook = hook;
  }

  isSessionInvalid(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /session (?:not found|does not exist)|unknown session/i.test(message);
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memoryHook) {
      throw new Error('Copilot memory session hook was not registered');
    }

    const pending = [input.prompt];
    let wake: (() => void) | undefined;
    let ended = false;
    let aborted = false;
    let session: CopilotSession | undefined;
    const client = this.makeClient();
    const config = copilotSessionConfig(this.options, input);
    const events: ProviderEvent[] = [];
    let inFlight = 0;
    let needsStartupMemory = !input.continuation;
    const emit = (event: ProviderEvent): void => {
      events.push(event);
      wake?.();
    };

    const handleEvent = (event: SessionEvent): void => {
      emit({ type: 'activity' });
      if (event.type === 'assistant.message_delta' && !event.agentId) {
        if (event.data.deltaContent) {
          streamedText = true;
          emit({ type: 'text', text: event.data.deltaContent });
        }
      } else if (event.type === 'assistant.message' && !event.agentId) {
        lastText = event.data.content;
        if (!streamedText && lastText) {
          emit({ type: 'text', text: lastText });
        }
        streamedText = false;
      } else if (event.type === 'session.error') {
        if (inFlight > 0) {
          inFlight--;
        } else {
          pending.length = 0;
          ended = true;
        }
        emit({ type: 'result', text: null, isError: true, error: event.data.message });
        lastText = '';
        streamedText = false;
      } else if (event.type === 'session.idle' && !event.agentId && inFlight > 0) {
        inFlight--;
        emit({ type: 'result', text: lastText || null });
        lastText = '';
        streamedText = false;
      }
    };
    let lastText = '';
    let streamedText = false;

    const queryEvents = async function* (): AsyncGenerator<ProviderEvent> {
      let unsubscribe: (() => void) | undefined;
      try {
        await client.start();
        if (aborted) {
          return;
        }
        if (!(await client.getAuthStatus()).isAuthenticated) {
          throw new Error(
            'Copilot authentication failed through the credential gateway; run `pnpm exec tsx scripts/copilot-login.ts` on the host',
          );
        }
        session = input.continuation
          ? await client.resumeSession(input.continuation, config)
          : await client.createSession(config);
        unsubscribe = session.on(handleEvent);
        emit({ type: 'init', continuation: session.sessionId });

        while (!aborted) {
          if (pending.length > 0 && inFlight === 0 && events.length === 0) {
            const prompt = pending.shift();
            if (prompt !== undefined) {
              const memory = needsStartupMemory ? memoryContextForSessionStart('startup', input.cwd) : undefined;
              needsStartupMemory = false;
              inFlight++;
              await session.send({ prompt: memory ? `${memory}\n\n${prompt}` : prompt });
              emit({ type: 'activity' });
            }
          }
          if (events.length > 0) {
            yield events.shift()!;
            continue;
          }
          if (ended && pending.length === 0 && inFlight === 0) {
            break;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        unsubscribe?.();
        try {
          if (session) {
            await session.disconnect();
          }
        } finally {
          const errors = await client.stop();
          for (const error of errors) {
            console.error('[copilot-provider] SDK shutdown failed:', error);
          }
        }
      }
    };

    return {
      push(prompt: string): void {
        if (ended || aborted) {
          throw new Error('Copilot query has ended');
        }
        pending.push(prompt);
        wake?.();
      },
      end(): void {
        ended = true;
        wake?.();
      },
      abort(): void {
        aborted = true;
        void session?.abort().catch((error: unknown) => {
          console.error('[copilot-provider] Failed to abort session:', error);
        });
        wake?.();
      },
      events: queryEvents(),
    };
  }
}

registerProvider('copilot', (options) => new CopilotProvider(options));
