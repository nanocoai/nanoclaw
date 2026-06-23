/**
 * Manifest provider — routes requests through a Manifest model router
 * via its OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Manifest scores each request by complexity and routes it to the best
 * model that can handle it. The provider sends standard OpenAI chat
 * completion requests and streams SSE responses back as provider events.
 */
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string; role?: string };
    finish_reason?: string | null;
  }>;
  id?: string;
}

export class ManifestProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly usesMemoryScaffold = true;

  private baseUrl: string;
  private authToken: string;
  private model: string;

  constructor(options: ProviderOptions = {}) {
    this.baseUrl = (options.env?.MANIFEST_BASE_URL ?? 'http://localhost:3001/v1').replace(/\/+$/, '');
    this.authToken = options.env?.MANIFEST_AUTH_TOKEN ?? 'placeholder';
    this.model = options.model ?? 'auto';
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let abortController: AbortController | null = null;

    const self = this;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        const sessionId = `manifest-${Date.now()}`;
        yield { type: 'activity' };
        yield { type: 'init', continuation: sessionId };

        const history: ChatMessage[] = [];

        if (input.systemContext?.instructions) {
          history.push({ role: 'system', content: input.systemContext.instructions });
        }
        history.push({ role: 'user', content: input.prompt });

        yield* self.streamCompletion(history, abortController = new AbortController());

        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            history.push({ role: 'user', content: msg });
            yield* self.streamCompletion(history, abortController = new AbortController());
            continue;
          }
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        while (pending.length > 0) {
          const msg = pending.shift()!;
          history.push({ role: 'user', content: msg });
          yield* self.streamCompletion(history, abortController = new AbortController());
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
        abortController?.abort();
        waiting?.();
      },
    };
  }

  private async *streamCompletion(
    messages: ChatMessage[],
    abortController: AbortController,
  ): AsyncIterable<ProviderEvent> {
    yield { type: 'activity' };

    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages,
      stream: true,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body,
        signal: abortController.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message: `Manifest request failed: ${message}`, retryable: true };
      return;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      yield {
        type: 'error',
        message: `Manifest returned ${response.status}: ${detail.slice(0, 500)}`,
        retryable: response.status >= 500 || response.status === 429,
      };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'error', message: 'Manifest response has no body', retryable: false };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        yield { type: 'activity' };
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const chunk: ChatCompletionChunk = JSON.parse(trimmed.slice(6));
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) {
              fullText += content;
              yield { type: 'progress', message: content };
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message: `Stream error: ${message}`, retryable: true };
        return;
      }
    } finally {
      reader.releaseLock();
    }

    messages.push({ role: 'assistant', content: fullText });
    yield { type: 'result', text: fullText || null };
  }
}

registerProvider('manifest', (opts) => new ManifestProvider(opts));
