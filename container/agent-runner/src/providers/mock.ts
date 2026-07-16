import { registerProvider } from './provider-registry.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

export type MockFailMode = 'quota' | 'billing' | 'overload';

function parseFailMode(): MockFailMode | null {
  const raw = process.env.MOCK_PROVIDER_FAIL?.trim().toLowerCase();
  if (raw === 'quota' || raw === 'billing' || raw === 'overload') return raw;
  return null;
}

function parseResetAt(): number | null {
  const raw = process.env.MOCK_RESET_AT;
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function failEvents(mode: MockFailMode): ProviderEvent[] {
  const resetAt = parseResetAt();
  const ts = resetAt ? new Date(resetAt * 1000).toISOString() : 'unknown';

  if (mode === 'billing') {
    return [
      { type: 'result', text: `Your credit balance is too low to continue. Please top up to resume.`, isError: true } as ProviderEvent,
    ];
  }

  return [
    {
      type: 'error',
      message: mode === 'quota'
        ? `Usage limit reached — resets at ${ts}`
        : `API overload: 6 consecutive retries over 300s`,
      retryable: false,
      classification: mode,
      resetAt: resetAt ? resetAt * 1000 : null,
    } as ProviderEvent,
  ];
}

/**
 * Mock provider for testing. Returns canned responses.
 *
 * When `MOCK_PROVIDER_FAIL=quota|billing|overload`, simulates a provider
 * limit error that triggers the fallback flow (spec A10). `MOCK_RESET_AT`
 * (unix seconds) sets the limit reset time.
 *
 * In tests, pass failMode directly to the constructor to avoid env-var
 * cross-contamination between test cases.
 */
export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private responseFactory: (prompt: string) => string;
  private failMode: MockFailMode | null;
  private failConsumed = false;

  constructor(_options: ProviderOptions = {}, responseFactory?: (prompt: string) => string, failMode?: MockFailMode | null) {
    this.responseFactory = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
    this.failMode = failMode !== undefined ? failMode : parseFailMode();
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
    const shouldFail = this.failMode && !this.failConsumed;
    const failMode = this.failMode;
    this.failConsumed = true;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: `mock-session-${Date.now()}` };

        if (shouldFail) {
          yield { type: 'activity' };
          for (const ev of failEvents(failMode!)) {
            yield ev;
          }
        } else {
          yield { type: 'activity' };
          yield { type: 'result', text: responseFactory(input.prompt) };
        }

        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            yield { type: 'result', text: responseFactory(msg) };
            continue;
          }
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        while (pending.length > 0) {
          const msg = pending.shift()!;
          yield { type: 'result', text: responseFactory(msg) };
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
