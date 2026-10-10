/**
 * Thin REST client over the Mattermost v4 API.
 *
 * Uses Node 20+ native `fetch`. Every call carries the bot token as
 * `Authorization: Bearer <token>`, is bounded by a request timeout (a hung
 * upstream must not hang the host's delivery loop), and retries once on a
 * 429 for as long as the server's own `Retry-After` / `X-RateLimit-Reset`
 * asks — Mattermost rate-limits per token, and a burst of reactions or typing
 * indicators is exactly the shape that trips it.
 */

import type {
  MattermostChannelInfo,
  MattermostChannelStats,
  MattermostFileInfo,
  MattermostFileUploadResponse,
  MattermostPost,
  MattermostPostList,
  MattermostUser,
} from './types.js';

export class MattermostApiError extends Error {
  readonly body: string;
  readonly status: number;

  constructor(status: number, method: string, path: string, body: string) {
    super(`Mattermost ${method} ${path} failed with ${status}: ${body}`);
    this.name = 'MattermostApiError';
    this.status = status;
    this.body = body;
  }

  /** Mattermost's machine-readable error id (`api.context.404.app_error`), if the body carried one. */
  get errorId(): string | undefined {
    try {
      const parsed = JSON.parse(this.body) as { id?: unknown };
      return typeof parsed.id === 'string' ? parsed.id : undefined;
    } catch {
      return undefined;
    }
  }
}

export interface MattermostRestOptions {
  /** Instance base URL, e.g. `https://mm.example.com`. */
  baseUrl: string;
  /** Bot account token. */
  token: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request deadline. Default 30s. */
  timeoutMs?: number;
  /**
   * Longest a 429 is waited out before giving up and surfacing it. Default
   * 10s: anything the server asks beyond that is better reported than slept.
   */
  maxRateLimitWaitMs?: number;
  /** Injectable for tests. Defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Strip any trailing slashes so path joins stay predictable. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Normalize the SDK's `FileUpload.data` union onto the one type `FormData`
 * accepts. A `Buffer` is a `Uint8Array` view, so it is copied into a fresh
 * `Blob` rather than passed through.
 */
function toBlob(data: Blob | Buffer | ArrayBuffer, mimeType?: string): Blob {
  const type = mimeType ? { type: mimeType } : undefined;
  if (data instanceof Blob) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Blob([data], type);
  }
  return new Blob([new Uint8Array(data)], type);
}

/**
 * How long a 429 asks us to wait, in ms, or `undefined` when the response
 * says nothing usable. `Retry-After` (seconds) wins; Mattermost's own
 * `X-RateLimit-Reset` (epoch seconds) is the fallback.
 */
export function rateLimitDelayMs(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) {
      return Math.max(0, Math.round(epochSeconds * 1000 - now));
    }
  }
  return undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MattermostRestClient {
  readonly apiUrl: string;
  readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;
  private readonly maxRateLimitWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly token: string;

  constructor(options: MattermostRestOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiUrl = `${this.baseUrl}/api/v4`;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 10_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Authenticated URL of a file's bytes — needs the bot token to resolve. */
  fileUrl(fileId: string): string {
    return `${this.apiUrl}/files/${fileId}`;
  }

  /** Profile image of a user — needs the bot token to resolve. */
  userImageUrl(userId: string): string {
    return `${this.apiUrl}/users/${userId}/image`;
  }

  async request<T>(
    method: string,
    path: string,
    init?: { body?: unknown; query?: Record<string, string | number | undefined> },
  ): Promise<T> {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(init?.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    let body: string | undefined;
    if (init?.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }

    const response = await this.send(method, path, () =>
      this.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        signal: this.signal(),
      }),
    );
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * POST a `FormData` body. Kept separate from {@link request} because the
   * boundary has to be generated by `fetch` itself — setting `content-type`
   * by hand (as `request` does for JSON) produces a body the server cannot
   * parse.
   */
  private async requestForm<T>(path: string, form: FormData): Promise<T> {
    const response = await this.send('POST', path, () =>
      this.fetchImpl(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
        body: form,
        signal: this.signal(),
      }),
    );
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Run one request, converting non-2xx into {@link MattermostApiError} and
   * waiting out a single 429 when the server says how long.
   */
  private async send(method: string, path: string, attempt: () => Promise<Response>): Promise<Response> {
    let response = await attempt();
    if (response.status === 429) {
      const delay = rateLimitDelayMs(response.headers);
      if (delay !== undefined && delay <= this.maxRateLimitWaitMs) {
        await response.text().catch(() => '');
        await this.sleep(delay);
        response = await attempt();
      }
    }
    if (!response.ok) {
      throw new MattermostApiError(response.status, method, path, await response.text().catch(() => ''));
    }
    return response;
  }

  private signal(): AbortSignal | undefined {
    return this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined;
  }

  // -- users ---------------------------------------------------------------

  getMe(): Promise<MattermostUser> {
    return this.request<MattermostUser>('GET', '/users/me');
  }

  getUser(userId: string): Promise<MattermostUser> {
    return this.request<MattermostUser>('GET', `/users/${userId}`);
  }

  /** GetUserByUsername. `username` without the leading `@`. */
  getUserByUsername(username: string): Promise<MattermostUser> {
    return this.request<MattermostUser>('GET', `/users/username/${encodeURIComponent(username)}`);
  }

  // -- posts ---------------------------------------------------------------

  createPost(body: Partial<MattermostPost>): Promise<MattermostPost> {
    return this.request<MattermostPost>('POST', '/posts', { body });
  }

  /**
   * CreateEphemeralPost — visible to `userId` only. Gated server-side on the
   * `create_post_ephemeral` permission (system admins only on Team Edition);
   * a bot without it gets a 403, which `MattermostAdapter.postEphemeral`
   * turns into a DM fallback.
   */
  createEphemeralPost(userId: string, post: Partial<MattermostPost>): Promise<MattermostPost> {
    return this.request<MattermostPost>('POST', '/posts/ephemeral', {
      body: { user_id: userId, post },
    });
  }

  patchPost(postId: string, body: Partial<MattermostPost>): Promise<MattermostPost> {
    return this.request<MattermostPost>('PUT', `/posts/${postId}/patch`, { body });
  }

  deletePost(postId: string): Promise<void> {
    return this.request<void>('DELETE', `/posts/${postId}`);
  }

  getPost(postId: string): Promise<MattermostPost> {
    return this.request<MattermostPost>('GET', `/posts/${postId}`);
  }

  /** Paginated channel posts. `order` is newest-first. */
  getChannelPosts(
    channelId: string,
    query: { after?: string; before?: string; page?: number; per_page?: number },
  ): Promise<MattermostPostList> {
    return this.request<MattermostPostList>('GET', `/channels/${channelId}/posts`, { query });
  }

  /** GetPostThread: the root post plus all of its replies. */
  getPostThread(
    rootId: string,
    query: { perPage?: number; skipFetchThreads?: string } = {},
  ): Promise<MattermostPostList> {
    return this.request<MattermostPostList>('GET', `/posts/${rootId}/thread`, { query });
  }

  // -- files ---------------------------------------------------------------

  /**
   * UploadFile. Returns the created {@link MattermostFileInfo}.
   *
   * Mattermost's upload is a two-step affair: a file is uploaded to a channel
   * first, and is only bound to a post when a later `CreatePost` names its id
   * in `file_ids` (an unreferenced upload is garbage-collected). That differs
   * from Slack, whose `files.uploadV2` publishes a post of its own — which is
   * why this adapter can attach files to the *same* post as the text, and
   * Slack cannot.
   *
   * Live-verified against Mattermost Team Edition on 2026-07-24: 201 with a
   * single-element `file_infos`.
   */
  async uploadFile(
    channelId: string,
    file: { data: Blob | Buffer | ArrayBuffer; filename: string; mimeType?: string },
  ): Promise<MattermostFileInfo> {
    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('files', toBlob(file.data, file.mimeType), file.filename);
    const result = await this.requestForm<MattermostFileUploadResponse>('/files', form);
    const info = result?.file_infos?.[0];
    if (!info?.id) {
      throw new Error(`Mattermost upload of ${file.filename} returned no file info`);
    }
    return info;
  }

  /** GetFile: the raw bytes of an uploaded file. Requires the bot token. */
  async getFile(fileId: string): Promise<Buffer> {
    const response = await this.send('GET', `/files/${fileId}`, () =>
      this.fetchImpl(this.fileUrl(fileId), {
        headers: { authorization: `Bearer ${this.token}` },
        signal: this.signal(),
      }),
    );
    return Buffer.from(await response.arrayBuffer());
  }

  // -- channels ------------------------------------------------------------

  getChannel(channelId: string): Promise<MattermostChannelInfo> {
    return this.request<MattermostChannelInfo>('GET', `/channels/${channelId}`);
  }

  getChannelStats(channelId: string): Promise<MattermostChannelStats> {
    return this.request<MattermostChannelStats>('GET', `/channels/${channelId}/stats`);
  }

  /** CreateDirectChannel — the DM channel between the bot and `userId`. */
  createDirectChannel(botUserId: string, userId: string): Promise<MattermostChannelInfo> {
    return this.request<MattermostChannelInfo>('POST', '/channels/direct', {
      body: [botUserId, userId],
    });
  }

  // -- reactions -----------------------------------------------------------

  addReaction(userId: string, postId: string, emojiName: string): Promise<void> {
    return this.request<void>('POST', '/reactions', {
      body: { user_id: userId, post_id: postId, emoji_name: emojiName },
    });
  }

  removeReaction(userId: string, postId: string, emojiName: string): Promise<void> {
    // `+1` / `-1` are legal emoji names and `+` is not path-safe.
    return this.request<void>('DELETE', `/users/${userId}/posts/${postId}/reactions/${encodeURIComponent(emojiName)}`);
  }

  // -- typing --------------------------------------------------------------

  /** PublishUserTyping: broadcasts a `typing` WebSocket event to the channel. */
  publishUserTyping(userId: string, body: { channel_id: string; parent_id?: string }): Promise<void> {
    return this.request<void>('POST', `/users/${userId}/typing`, { body });
  }
}
