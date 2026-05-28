import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ContentBlock, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

/**
 * Mock provider for testing. Returns canned responses.
 * Supports push() — queued messages produce additional results.
 */
export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly supportsMultimodalContent = true;

  private responseFactory: (prompt: string) => string;

  constructor(_options: ProviderOptions = {}, responseFactory?: (prompt: string) => string) {
    this.responseFactory = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const responseFactory = this.responseFactory;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: `mock-session-${Date.now()}` };

        // Process initial prompt
        yield { type: 'activity' };
        yield { type: 'result', text: responseFactory(input.prompt) };

        // Process any pushed follow-ups
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            yield { type: 'result', text: responseFactory(msg) };
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
          yield { type: 'result', text: responseFactory(msg) };
        }
      },
    };

    return {
      push(message: string) {
        pending.push(message);
        waiting?.();
      },
      pushBlocks(blocks: ContentBlock[]) {
        // Mirror the v1 pattern: surface a synthetic text turn that summarizes
        // the block array so tests can assert against the prompt path without
        // pulling base64 binary data through the mock.
        const summary = blocks
          .map((b) => (b.type === 'image' ? `[image:${b.source.media_type}]` : b.text))
          .join(' ');
        pending.push(`__BLOCKS__ ${summary}`);
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
