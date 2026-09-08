import { randomBytes } from 'crypto';

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface OpenCodeMessage {
  info: {
    id: string;
    role: string;
    parentID?: string;
    summary?: boolean;
    error?: unknown;
    time: { created: number; completed?: number };
  };
  parts: Array<{ id: string; type: string; text?: string; ignored?: boolean }>;
}

export interface OpenCodeTurnResult {
  text: string | null;
  isError?: boolean;
}

export interface OpenCodeSessionClient {
  create(params?: { signal?: AbortSignal }): Promise<{ data?: { id?: string }; error?: unknown }>;
  prompt(params: {
    path: { id: string };
    body: { messageID: string; parts: unknown[] };
    signal?: AbortSignal;
  }): Promise<{ data?: OpenCodeMessage; error?: unknown }>;
  messages(params: {
    path: { id: string };
    query: { limit: number };
    signal?: AbortSignal;
  }): Promise<{ data?: OpenCodeMessage[]; error?: unknown }>;
  abort(params: { path: { id: string }; signal?: AbortSignal }): Promise<{ error?: unknown }>;
}

/** One eager reader per runtime; no parked per-turn iterator can eat a later event. */
export class OpenCodeEventPump {
  readonly ready: Promise<void>;
  lastEventAt = Date.now();
  failure?: Error;
  private listeners = new Set<(event?: OpenCodeEvent) => void>();
  private parents = new Map<string, string | undefined>();

  constructor(stream: AsyncGenerator<OpenCodeEvent, void, void>, onEvent: (event: OpenCodeEvent) => void) {
    let connected!: () => void;
    let reject!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, fail) => {
      connected = resolve;
      reject = fail;
    });
    // Initialization may fail before a caller reaches ready. Keep the rejection observed.
    void this.ready.catch(() => {});
    void (async () => {
      try {
        for await (const event of stream) {
          this.lastEventAt = Date.now();
          if (event.type === 'server.connected') connected();
          if (event.type === 'session.created' || event.type === 'session.updated') {
            const info = event.properties.info as { id?: string; parentID?: string } | undefined;
            if (info?.id) this.parents.set(info.id, info.parentID);
          }
          onEvent(event);
          for (const listener of this.listeners) listener(event);
        }
        throw new Error('OpenCode event stream ended unexpectedly');
      } catch (error) {
        this.failure = new Error(
          `OpenCode event stream failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        reject(this.failure);
        for (const listener of this.listeners) listener();
      }
    })();
  }

  listen(listener: (event?: OpenCodeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  belongsTo(sessionId: string | undefined, ancestor: string): boolean {
    for (let depth = 0; sessionId && depth < 32; depth++) {
      if (sessionId === ancestor) return true;
      sessionId = this.parents.get(sessionId);
    }
    return false;
  }
}

const turns = new WeakMap<object, Promise<void>>();

/** The native server joins concurrent calls to one run; queue them here instead. */
export async function acquireOpenCodeTurn(runtime: object, signal: AbortSignal): Promise<() => void> {
  const previous = turns.get(runtime) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  turns.set(runtime, tail);
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('OpenCode query aborted'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    await Promise.race([previous, cancelled]);
  } catch (error) {
    release();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return release;
}

let messageCounter = 0;
export function createOpenCodeMessageId(): string {
  const time = (BigInt(Date.now()) * 4096n + BigInt(messageCounter++ % 4096)) & ((1n << 48n) - 1n);
  // OpenCode's native IDs use a 12-hex time/counter prefix and 14 base62 characters.
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const suffix = Array.from(randomBytes(14), (byte) => alphabet[byte % alphabet.length]).join('');
  return `msg_${time.toString(16).padStart(12, '0')}${suffix}`;
}

export function openCodeError(error: unknown): Error {
  return new Error(`OpenCode prompt failed: ${JSON.stringify(error)}`);
}

export async function boundedOpenCodeCall<T>(
  call: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeout = 10_000,
): Promise<T> {
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forward, { once: true });
  if (signal?.aborted) forward();
  const timer = setTimeout(() => controller.abort(new Error('OpenCode control request timed out')), timeout);
  let reject!: (error: Error) => void;
  const cancelled = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const cancel = () => reject(controller.signal.reason ?? new Error('OpenCode query aborted'));
  controller.signal.addEventListener('abort', cancel, { once: true });
  if (controller.signal.aborted) cancel();
  try {
    return await Promise.race([call(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
    controller.signal.removeEventListener('abort', cancel);
  }
}

export async function* executeOpenCodeTurn(options: {
  runtime: object;
  client: OpenCodeSessionClient;
  pump: OpenCodeEventPump;
  sessionId: string;
  parts: unknown[];
  signal: AbortSignal;
  silenceMs: number;
  idleMs: number;
  prepare?(): void;
  discard(): void;
}): AsyncGenerator<{ type: 'activity' } | { type: 'error'; message: string; retryable: false }, OpenCodeTurnResult> {
  const { client, pump, sessionId, signal } = options;
  const release = await acquireOpenCodeTurn(options.runtime, signal);
  const request = new AbortController();
  let started = false;
  let promptRequest: ReturnType<OpenCodeSessionClient['prompt']> | undefined;
  let completedResponse = false;
  let streamSilent = false;
  let failure: Error | undefined;
  let activity = false;
  let lastActivityAt = Date.now();
  let wake: (() => void) | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    wake?.();
  };
  const cancelled = () => fail(new Error('OpenCode query aborted'));
  signal.addEventListener('abort', cancelled, { once: true });
  const unlisten = pump.listen((event) => {
    if (!event) return fail(pump.failure!);
    const properties = event.properties;
    const record = (properties.info ?? properties.part ?? properties) as { sessionID?: string };
    if (!pump.belongsTo(record.sessionID, sessionId)) return;
    // Error/idle events can belong to an earlier run or recoverable compaction.
    // Native execution also owns retry policy; retry status is activity, not
    // an independent limit that can cut off a recoverable native request.
    // Only the synchronous response determines whether this turn succeeded.
    if (event.type === 'session.idle' || event.type === 'session.error') return;
    activity = true;
    lastActivityAt = Date.now();
    wake?.();
  });
  const timer = setInterval(
    () => {
      if (Date.now() - pump.lastEventAt >= options.silenceMs) {
        streamSilent = true;
        fail(new Error(`OpenCode event stream silent for ${options.silenceMs}ms; server dropped`));
      } else if (Date.now() - lastActivityAt >= options.idleMs) {
        fail(new Error(`OpenCode turn produced no activity for ${options.idleMs}ms; aborted`));
      }
    },
    Math.min(5000, options.silenceMs, options.idleMs),
  );
  try {
    if (signal.aborted) cancelled();
    await boundedOpenCodeCall(() => pump.ready, signal);
    if (pump.failure) throw pump.failure;
    const prior = await boundedOpenCodeCall(
      (signal) => client.messages({ path: { id: sessionId }, query: { limit: 100 }, signal }),
      signal,
    );
    if (prior.error) throw openCodeError(prior.error);
    if (failure) throw failure;
    options.prepare?.();
    const messageId = createOpenCodeMessageId();
    let response: Awaited<ReturnType<OpenCodeSessionClient['prompt']>> | undefined;
    let finished = false;
    started = true;
    promptRequest = client.prompt({
      path: { id: sessionId },
      body: { messageID: messageId, parts: options.parts },
      signal: request.signal,
    });
    void promptRequest.then(
      (value) => {
        response = value;
        finished = true;
        completedResponse = true;
        wake?.();
      },
      (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
    while (!finished && !failure) {
      if (activity) {
        activity = false;
        yield { type: 'activity' };
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
    if (failure) throw failure;
    if (response?.error) throw openCodeError(response.error);
    if (!response?.data) throw new Error('OpenCode prompt returned no completed assistant');
    const text = await reconcileOpenCodeTurn(
      client,
      sessionId,
      messageId,
      response.data,
      new Set((prior.data ?? []).map((m) => m.info.id)),
      signal,
    );
    if (response.data.info.error) {
      const message = openCodeError(response.data.info.error).message;
      yield { type: 'error', message, retryable: false };
      // One final result preserves completed earlier steps without duplicate
      // exchange callbacks or an automatic retry of the failed turn. Core
      // delivers wrapped chat text and logs failed task output;
      // with no wrapped reply, isError also makes the failure notice deliverable.
      return { text: [text, message].filter(Boolean).join('\n\n'), isError: true };
    }
    return { text };
  } finally {
    clearInterval(timer);
    unlisten();
    signal.removeEventListener('abort', cancelled);
    // HTTP disconnect only cancels its waiter. Stop native execution explicitly,
    // then release the serialization lock. If cleanup cannot be confirmed, kill
    // the owned runtime so a later prompt cannot join an abandoned native run.
    if (started && !completedResponse) {
      try {
        const result = await boundedOpenCodeCall((signal) => client.abort({ path: { id: sessionId }, signal }));
        if (result.error) throw openCodeError(result.error);
        // An abort can arrive before prompt registration. The original HTTP
        // completion must also settle; an abort acknowledgement alone proves
        // nothing about that race. A lost response forces runtime teardown.
        if (!completedResponse && promptRequest) await boundedOpenCodeCall(() => promptRequest!);
      } catch {
        options.discard();
      }
    }
    if (pump.failure || streamSilent) options.discard();
    request.abort();
    release();
  }
}

/** Read enough of the durable suffix to prove which prompt the response belongs to. */
export async function reconcileOpenCodeTurn(
  client: OpenCodeSessionClient,
  sessionId: string,
  messageId: string,
  result: OpenCodeMessage,
  priorIds: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<string | null> {
  let messages: OpenCodeMessage[] = [];
  let marker: OpenCodeMessage | undefined;
  for (let limit = 100; limit <= 6400; limit *= 2) {
    // Each request has its own bound. A long but healthy history can require
    // several reads; one shared deadline would discard an already completed
    // reply even when every individual request responds promptly.
    const response = await boundedOpenCodeCall(
      (signal) => client.messages({ path: { id: sessionId }, query: { limit }, signal }),
      signal,
    );
    if (response.error) throw openCodeError(response.error);
    messages = response.data ?? [];
    marker = messages.find((message) => message.info.id === messageId && message.info.role === 'user');
    if (marker) break;
    if (messages.length < limit) break;
  }
  if (!marker) throw new Error('OpenCode completed without a verifiable prompt in session history; refusing to replay');

  // Compaction creates replay/auto-continue user messages. Include those descendants,
  // even when an independent native ID counter puts them before our marker in a tie.
  const users = new Set(
    messages
      .filter(
        (message) =>
          message.info.role === 'user' &&
          message.info.time.created >= marker!.info.time.created &&
          !priorIds.has(message.info.id),
      )
      .map((message) => message.info.id),
  );
  users.add(messageId);
  const assistants = messages.filter(
    (message) => message.info.role === 'assistant' && message.info.parentID && users.has(message.info.parentID),
  );
  if (!assistants.some((message) => message.info.id === result.info.id)) {
    throw new Error('OpenCode returned an assistant from another turn; refusing to replay');
  }
  const parts = new Set<string>();
  const text: string[] = [];
  for (const message of assistants) {
    // A recovered overflow record is not the outcome, and a summary is internal context.
    if (message.info.summary || message.info.error) continue;
    if (result.info.error && message.info.time.completed === undefined) continue;
    for (const part of message.parts) {
      if (part.type !== 'text' || part.ignored || !part.text || parts.has(part.id)) continue;
      parts.add(part.id);
      text.push(part.text);
    }
  }
  return text.join('\n\n') || null;
}
