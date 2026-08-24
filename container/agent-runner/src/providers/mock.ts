import { registerProvider } from './provider-registry.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

/**
 * Mock provider for testing. Returns canned responses.
 * Supports push() — queued messages produce additional results.
 */
export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  /**
   * Mirrors ClaudeProvider: turnEvents() emits every configured text segment
   * before the turn's result, so the mock exercises the same one-door
   * mid-turn delivery path as the real SDK.
   */
  readonly emitsMidTurnText = true;

  private responseFactory: (prompt: string) => string;
  private textFactory: ((prompt: string) => string[]) | undefined;

  constructor(
    _options: ProviderOptions = {},
    responseFactory?: (prompt: string) => string,
    /**
     * Optional mid-turn text segments: returns the `text` events to emit
     * before the result for a given prompt (mirrors SDK assistant messages
     * emitted between tool calls).
     */
    textFactory?: (prompt: string) => string[],
  ) {
    this.responseFactory = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
    this.textFactory = textFactory;
  }

  registerMemorySessionHook(_hook: MemorySessionHookRegistration): void {}

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const responseFactory = this.responseFactory;
    const textFactory = this.textFactory;
    // Mid-turn text segments (if configured) followed by the turn's result —
    // mirrors the SDK's assistant-message → result ordering. The result text
    // itself streams as the LAST text event first: the real SDK's result only
    // repeats the final assistant text, which already streamed — that is the
    // emitsMidTurnText contract this mock declares.
    function* turnEvents(prompt: string): Generator<ProviderEvent> {
      for (const text of textFactory?.(prompt) ?? []) {
        yield { type: 'text', text };
      }
      const result = responseFactory(prompt);
      if (result) yield { type: 'text', text: result };
      yield { type: 'result', text: result };
    }

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: `mock-session-${Date.now()}` };

        // Process initial prompt
        yield { type: 'activity' };
        yield* turnEvents(input.prompt);

        // Process any pushed follow-ups
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            yield* turnEvents(msg);
            continue;
          }
          // Wait for push() or end()
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        // Drain remaining
        while (pending.length > 0) {
          const msg = pending.shift()!;
          yield* turnEvents(msg);
        }
      },
    };

    return {
      push(message: string) {
        pending.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events,
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }
}

registerProvider('mock', (opts) => new MockProvider(opts));
