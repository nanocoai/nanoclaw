/**
 * Client for the service routes that manage a coding session's chat surface.
 *
 * The service is the same one that provisions the host's managed Slack app;
 * the bearer is the same registry install token; the origin is the one the
 * saved install names (install.ts). Every route is under
 * `/v1/code-channels`. Responses are JSON; failures are `{ error, message }`
 * with a meaningful status, surfaced here as SessionChannelServiceError so
 * callers branch on a code rather than parse prose.
 *
 * Two codes matter to callers:
 *   - "unavailable" (isUnavailable): the workspace or the deployment cannot
 *     do this at all (feature off, manager app lacking the scopes, service
 *     flag off). A sandbox degrades silently — it works without a channel.
 *   - session_stopped (isSessionStopped): the user pressed Stop; the service
 *     refuses status/views until the host declares the next human turn with
 *     `resume: true`.
 *
 * Nothing here retries: the mirror runs on a tick and the long-poll loop
 * has its own backoff (runtime.ts).
 */
import { setTimeout as sleep } from 'node:timers/promises';

export type SessionStatus = 'active' | 'processing' | 'suspended' | 'closed';

export type ViewType = 'diff' | 'html' | 'block_kit' | 'canvas';

/** The service's one code tab lives at this view key. */
export const DIFF_VIEW_KEY = 'diff';

/** The service caps a long-poll at this many seconds (API gateway ceiling). */
export const LONG_POLL_MAX_SECONDS = 25;

/** Notification type the service relays when the user stops the session from the channel. */
export const STOPPED_EVENT = 'code_channel.stopped';

export interface ChannelRecord {
  channelId: string;
  sessionId: string;
  teamId?: string;
  appId?: string;
  title?: string;
  /** The service's own view: active | processing | suspended | closed | stopped. */
  status: string;
  createdAt?: string;
  updatedAt?: string;
  stoppedAt?: string | null;
  archivedAt?: string | null;
  views?: Array<{ viewKey: string; type: string; name?: string | null; updatedAt?: string }>;
  contextBarItems?: Array<{ key: string; label: string; icon?: string; url?: string }>;
}

export interface ChannelEvent {
  cursor: string;
  type: string;
  channelId: string;
  sessionId: string;
  ts: string;
  threadTs?: string;
  user?: string;
}

export interface EventsPage {
  channelId: string;
  sessionId: string;
  status: string;
  events: ChannelEvent[];
  cursor: string | null;
}

export interface ViewBody {
  type: ViewType;
  name?: string;
  content?: string;
  blocks?: unknown[];
  baseBranch?: string;
  headBranch?: string;
  accessLevel?: 'comment' | 'read' | 'edit';
}

export interface ContextBarItem {
  key: string;
  label: string;
  icon?: string;
  url?: string;
  itemType?: 'info' | 'action';
}

export class SessionChannelServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly path: string;

  constructor(status: number, code: string, message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SessionChannelServiceError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

/** The service cannot give this host a channel at all — degrade, do not retry. */
const UNAVAILABLE_CODES = new Set([
  'code_channels_unavailable',
  'code_channels_disabled',
  'manager_missing_scope',
  'manager_bot_token_missing',
  'workspace_disconnected',
  'app_not_installed',
  'no_origin',
]);

export function isUnavailable(error: unknown): boolean {
  return error instanceof SessionChannelServiceError && UNAVAILABLE_CODES.has(error.code);
}

export function isSessionStopped(error: unknown): boolean {
  return error instanceof SessionChannelServiceError && error.code === 'session_stopped';
}

export function isNotFound(error: unknown): boolean {
  return error instanceof SessionChannelServiceError && error.status === 404;
}

/** The channel is gone for good (archived or unknown) — stop mirroring it. */
export function isChannelGone(error: unknown): boolean {
  return (
    error instanceof SessionChannelServiceError &&
    (error.status === 404 || error.code === 'already_archived' || error.code === 'is_archived')
  );
}

/**
 * The origin rule the install worker applies before it sends the bearer
 * anywhere: https, or plain http to loopback for a local service; never
 * credentials, query or fragment in the configured origin.
 */
export function validateServiceOrigin(serviceBase: string): string {
  let base: URL;
  try {
    base = new URL(serviceBase);
  } catch (error) {
    throw new SessionChannelServiceError(0, 'invalid_service', 'Invalid service origin.', serviceBase, {
      cause: error,
    });
  }
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
  ) {
    throw new SessionChannelServiceError(0, 'invalid_service', 'Invalid service origin.', serviceBase);
  }
  return base.origin;
}

export interface SessionChannelClientOptions {
  serviceBase: string;
  token: string;
  /** Test seam. */
  fetch?: typeof fetch;
  /** Per-request ceiling for ordinary calls (the long-poll adds its wait). */
  timeoutMs?: number;
}

export class SessionChannelClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SessionChannelClientOptions) {
    this.origin = validateServiceOrigin(options.serviceBase);
    this.token = options.token;
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Create the channel for a session, or return the existing one (idempotent on sessionId). */
  async create(input: {
    appId: string;
    sessionId: string;
    title: string;
    teamId?: string;
    botUserId?: string;
    origin?: { channel: string; ts: string };
  }): Promise<{ channel: ChannelRecord; created: boolean }> {
    const body = await this.request<ChannelRecord & { created?: boolean }>('POST', '/v1/code-channels', input);
    const { created, ...channel } = body;
    return { channel, created: created === true };
  }

  get(channelId: string): Promise<ChannelRecord> {
    return this.request<ChannelRecord>('GET', `/v1/code-channels/${encodeURIComponent(channelId)}`);
  }

  setStatus(
    channelId: string,
    status: SessionStatus,
    options: { resume?: boolean } = {},
  ): Promise<{ channelId: string; sessionId: string; status: SessionStatus; resumed?: boolean }> {
    return this.request('POST', `/v1/code-channels/${encodeURIComponent(channelId)}/status`, {
      status,
      ...(options.resume ? { resume: true } : {}),
    });
  }

  putView(
    channelId: string,
    viewKey: string,
    view: ViewBody,
  ): Promise<{ channelId: string; viewKey: string; type: string; views: number }> {
    return this.request(
      'PUT',
      `/v1/code-channels/${encodeURIComponent(channelId)}/views/${encodeURIComponent(viewKey)}`,
      view,
    );
  }

  putProperties(
    channelId: string,
    properties: { contextBarItems?: ContextBarItem[]; summaryMessage?: { messageTs: string; threadTs?: string } },
  ): Promise<{ channelId: string; contextBarItems: ContextBarItem[] }> {
    return this.request('PUT', `/v1/code-channels/${encodeURIComponent(channelId)}/properties`, properties);
  }

  archive(
    channelId: string,
    options: { summary?: string } = {},
  ): Promise<{ channelId: string; sessionId: string; status: string; archived: boolean; archivedAt: string }> {
    return this.request('POST', `/v1/code-channels/${encodeURIComponent(channelId)}/archive`, {
      ...(options.summary ? { summary: options.summary } : {}),
    });
  }

  /** Long-poll for host-bound notifications; returns as soon as one is queued or `wait` seconds pass. */
  events(
    channelId: string,
    options: { since?: string | null; wait?: number; signal?: AbortSignal } = {},
  ): Promise<EventsPage> {
    const wait = Math.max(0, Math.min(options.wait ?? LONG_POLL_MAX_SECONDS, LONG_POLL_MAX_SECONDS));
    const query = new URLSearchParams({ wait: String(wait) });
    if (options.since) query.set('since', options.since);
    return this.request<EventsPage>(
      'GET',
      `/v1/code-channels/${encodeURIComponent(channelId)}/events?${query.toString()}`,
      undefined,
      { timeoutMs: this.timeoutMs + wait * 1000, signal: options.signal },
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchFn(`${this.origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: 'error',
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new SessionChannelServiceError(
        0,
        'unreachable',
        `Service did not answer ${method} ${path}: ${message}`,
        path,
        {
          cause: error,
        },
      );
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        parsed = null;
      }
    }
    if (!response.ok) {
      const failure = (parsed ?? {}) as { error?: unknown; message?: unknown };
      const code = typeof failure.error === 'string' && failure.error ? failure.error : `http_${response.status}`;
      const message =
        typeof failure.message === 'string' && failure.message
          ? failure.message
          : `${method} ${path} failed with HTTP ${response.status}.`;
      throw new SessionChannelServiceError(response.status, code, message, path);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new SessionChannelServiceError(
        response.status,
        'bad_response',
        `${method} ${path} returned no JSON.`,
        path,
      );
    }
    return parsed as T;
  }
}

/** Backoff helper for the long-poll loop: bounded, jittered, abortable. */
export async function backoff(attempt: number, signal?: AbortSignal, baseMs = 2_000, maxMs = 60_000): Promise<void> {
  const delay = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 10)) * (0.5 + Math.random() * 0.5);
  try {
    await sleep(delay, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error;
  }
}
