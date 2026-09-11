/**
 * Mattermost WebSocket transport.
 *
 * Connects to `<baseUrl>/api/v4/websocket`, authenticates with an
 * `authentication_challenge` action carrying the bot token (Mattermost does
 * not accept the token as a header on the WS upgrade), and forwards decoded
 * event frames to a callback. Reconnects with exponential backoff.
 *
 * This is the Slack Socket Mode analogue: no inbound port is needed for
 * messages. Only button callbacks need one (spec §4).
 *
 * Two things a bare socket gets wrong, both handled here:
 *
 *  - **Half-open connections.** When the host sleeps (laptop lid) or a NAT
 *    entry expires, the TCP session dies without a FIN and `ws` never emits
 *    `close` — the adapter would sit deaf forever. A protocol-level ping runs
 *    every `heartbeatIntervalMs`; a pong that does not arrive within
 *    `heartbeatTimeoutMs` terminates the socket, which *does* emit `close` and
 *    so reconnects. Live-verified 2026-08-20: the server answers pings.
 *  - **Missed events across a reconnect.** Mattermost's reliable-websocket
 *    mode replays events a connection missed when the reconnect presents the
 *    previous `connection_id` (from the `hello` frame) and the next expected
 *    `sequence_number`. A server that cannot resume simply issues a fresh
 *    `hello`, so presenting them is never worse than not.
 */

import WebSocket from 'ws';

import type { MattermostHelloEventData, MattermostWebSocketEvent, MattermostWebSocketFrame } from './types.js';
import { isWebSocketReply } from './types.js';

export interface SocketLogger {
  debug(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}

export interface MattermostSocketOptions {
  /** How long to wait for the server to acknowledge the token. Default 10s. */
  authTimeoutMs?: number;
  /** Instance base URL (no trailing slash). */
  baseUrl: string;
  /** Interval between liveness pings. `0` disables the heartbeat. Default 30s. */
  heartbeatIntervalMs?: number;
  /** How long a pong may take before the socket is declared dead. Default 10s. */
  heartbeatTimeoutMs?: number;
  logger: SocketLogger;
  /** Cap on the reconnect backoff. Default 30s. */
  maxBackoffMs?: number;
  /** First reconnect delay. Default 1s. */
  minBackoffMs?: number;
  /** Called once per connection, after the server has accepted the token. */
  onConnected?: (info: { attempt: number; resumed: boolean }) => void;
  onEvent: (event: MattermostWebSocketEvent) => void;
  token: string;
  /** Injectable for tests. */
  webSocketImpl?: typeof WebSocket;
}

/**
 * Translate an http(s) base URL into its ws(s) WebSocket endpoint, optionally
 * carrying the reliable-websocket resume parameters.
 */
export function webSocketUrl(baseUrl: string, resume?: { connectionId: string; sequenceNumber: number }): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  const scheme = normalized.startsWith('https://') ? 'wss://' : normalized.startsWith('http://') ? 'ws://' : 'wss://';
  const host = normalized.replace(/^https?:\/\//, '');
  const url = `${scheme}${host}/api/v4/websocket`;
  if (!resume) {
    return url;
  }
  const params = new URLSearchParams({
    connection_id: resume.connectionId,
    sequence_number: String(resume.sequenceNumber),
  });
  return `${url}?${params.toString()}`;
}

/** Exponential backoff with equal jitter, capped at `max`. */
export function backoffDelay(attempt: number, min: number, max: number): number {
  const ceiling = Math.min(max, min * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

type Timer = ReturnType<typeof setTimeout>;

export class MattermostSocket {
  private attempt = 0;
  private closed = false;
  /** `connection_id` of the last `hello`; presented on reconnect to resume. */
  private connectionId: string | undefined;
  private heartbeatTimer: Timer | undefined;
  /** Whether this transport has completed authentication at least once. */
  private hasConnected = false;
  /** Next event `seq` the server should send; the resume cursor. */
  private nextSeq = 0;
  private readonly options: Required<
    Pick<
      MattermostSocketOptions,
      'authTimeoutMs' | 'heartbeatIntervalMs' | 'heartbeatTimeoutMs' | 'maxBackoffMs' | 'minBackoffMs'
    >
  > &
    MattermostSocketOptions;
  private pongTimer: Timer | undefined;
  private reconnectTimer: Timer | undefined;
  private seq = 1;
  private socket: WebSocket | undefined;

  constructor(options: MattermostSocketOptions) {
    // The defaults must survive an own key holding `undefined` — callers pass
    // optional config through verbatim (`heartbeatIntervalMs: maybeUndefined`),
    // and a `...options` spread over defaults would replace 30s with
    // `undefined`, which `setInterval` clamps to ~1ms.
    this.options = {
      ...options,
      authTimeoutMs: options.authTimeoutMs ?? 10_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 10_000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      minBackoffMs: options.minBackoffMs ?? 1_000,
    };
  }

  /** The server-issued connection id, once a `hello` has been seen. */
  get currentConnectionId(): string | undefined {
    return this.connectionId;
  }

  /** Whether a socket is open and has been accepted by the server. */
  get connected(): boolean {
    return this.socket?.readyState === 1 && this.heartbeatTimer !== undefined
      ? true
      : this.authenticatedSocket === this.socket && this.socket !== undefined;
  }

  private authenticatedSocket: WebSocket | undefined;

  /**
   * Open the connection. Resolves once the server has **accepted the token**,
   * not merely once TCP is up — a rejected token rejects this promise, so a
   * misconfiguration fails `initialize` instead of logging and idling.
   */
  connect(): Promise<void> {
    this.closed = false;
    const Impl = this.options.webSocketImpl ?? WebSocket;
    const resume = this.connectionId ? { connectionId: this.connectionId, sequenceNumber: this.nextSeq } : undefined;
    const url = webSocketUrl(this.options.baseUrl, resume);
    this.options.logger.debug('Mattermost WS: connecting', {
      url: url.replace(/connection_id=[^&]+/, 'connection_id=…'),
      resume: Boolean(resume),
    });

    return new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new Impl(url);
      } catch (error) {
        reject(error);
        return;
      }
      this.socket = socket;
      let settled = false;
      let authSeq = 0;
      let authTimer: Timer | undefined;
      const resumedFrom = this.connectionId;

      const settle = (error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        if (authTimer) {
          clearTimeout(authTimer);
        }
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };

      socket.on('open', () => {
        authSeq = this.seq;
        this.authenticate();
        authTimer = setTimeout(() => {
          this.options.logger.warn('Mattermost WS: authentication timed out');
          settle(new Error('Mattermost WebSocket authentication timed out'));
          this.terminate(socket);
        }, this.options.authTimeoutMs);
        authTimer.unref?.();
      });

      socket.on('message', (raw: unknown) => {
        const frame = this.decode(String(raw));
        if (!frame) {
          return;
        }
        if (isWebSocketReply(frame)) {
          if (frame.seq_reply === authSeq) {
            if (frame.status === 'OK') {
              const attempt = this.attempt;
              this.attempt = 0;
              this.hasConnected = true;
              this.authenticatedSocket = socket;
              this.startHeartbeat(socket);
              this.options.logger.info('Mattermost WS: connected', {
                resumed: Boolean(resumedFrom),
              });
              this.options.onConnected?.({ attempt, resumed: Boolean(resumedFrom) });
              settle();
            } else {
              const message = frame.error?.message ?? 'authentication rejected';
              this.options.logger.error('Mattermost WS: authentication failed', { frame });
              settle(new Error(`Mattermost WebSocket authentication failed: ${message}`));
              this.terminate(socket);
            }
            return;
          }
          if (frame.status !== 'OK') {
            this.options.logger.error('Mattermost WS: action failed', { frame });
          }
          return;
        }
        this.handleEvent(frame, resumedFrom);
      });

      socket.on('pong', () => {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = undefined;
        }
      });

      socket.on('error', (error: unknown) => {
        this.options.logger.warn('Mattermost WS: error', { error });
        settle(error);
        // `ws` normally follows an error with `close`, but the transport does
        // not guarantee that every implementation will. Terminate explicitly
        // so an initial `connect()` rejection cannot leave a live socket that
        // authenticates later, and so established sockets reliably enter the
        // close/reconnect path.
        this.terminate(socket);
      });

      socket.on('close', (code: number) => {
        this.options.logger.warn('Mattermost WS: closed', { code });
        this.stopHeartbeat();
        if (this.authenticatedSocket === socket) {
          this.authenticatedSocket = undefined;
        }
        if (this.socket === socket) {
          this.socket = undefined;
        }
        settle(new Error(`Mattermost WebSocket closed before authentication (code ${code})`));
        // Before the first successful authentication, `connect()`'s caller
        // owns failure handling. Starting a background reconnect here leaves
        // an adapter whose `initialize()` rejected alive and able to consume
        // messages later (and can duplicate a replacement adapter). Once a
        // connection has succeeded, reconnecting is transport lifecycle and
        // remains our responsibility.
        if (this.hasConnected) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /** Close the connection and stop reconnecting. */
  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    this.authenticatedSocket = undefined;
    if (socket) {
      try {
        socket.close();
      } catch (error) {
        this.options.logger.debug('Mattermost WS: close threw', { error });
      }
    }
  }

  /** Decode one text frame and dispatch it. Exposed for tests. */
  handleFrame(raw: string): void {
    const frame = this.decode(raw);
    if (!frame) {
      return;
    }
    if (isWebSocketReply(frame)) {
      if (frame.status !== 'OK') {
        this.options.logger.error('Mattermost WS: action failed', { frame });
      }
      return;
    }
    this.handleEvent(frame, undefined);
  }

  private decode(raw: string): MattermostWebSocketFrame | undefined {
    try {
      return JSON.parse(raw) as MattermostWebSocketFrame;
    } catch (error) {
      this.options.logger.warn('Mattermost WS: unparseable frame', { error });
      return undefined;
    }
  }

  /**
   * Track the resume cursor and surface the frame. `hello` is consumed here
   * (its connection id is transport state) but still forwarded, so an
   * adapter may log the server version.
   */
  private handleEvent(frame: MattermostWebSocketEvent, resumedFrom: string | undefined): void {
    if (!frame.event) {
      return;
    }
    if (frame.event === 'hello') {
      const data = frame.data as MattermostHelloEventData | undefined;
      if (data?.connection_id) {
        if (resumedFrom && data.connection_id !== resumedFrom) {
          this.options.logger.info(
            'Mattermost WS: server issued a new connection; events during the outage were not replayed',
            {
              serverVersion: data.server_version,
            },
          );
        }
        this.connectionId = data.connection_id;
      }
    }
    if (typeof frame.seq === 'number') {
      if (frame.seq !== this.nextSeq && frame.event !== 'hello') {
        this.options.logger.debug('Mattermost WS: sequence gap', {
          expected: this.nextSeq,
          received: frame.seq,
        });
      }
      this.nextSeq = frame.seq + 1;
    }
    this.options.onEvent(frame);
  }

  /** Send the `authentication_challenge` action with the bot token. */
  private authenticate(): void {
    this.send({
      action: 'authentication_challenge',
      data: { token: this.options.token },
      seq: this.seq++,
    });
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    if (this.options.heartbeatIntervalMs <= 0 || typeof socket.ping !== 'function') {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== 1) {
        return;
      }
      if (this.pongTimer) {
        // The previous ping is still unanswered; the deadline will fire.
        return;
      }
      try {
        socket.ping();
      } catch (error) {
        this.options.logger.debug('Mattermost WS: ping threw', { error });
        return;
      }
      this.pongTimer = setTimeout(() => {
        this.pongTimer = undefined;
        this.options.logger.warn('Mattermost WS: no pong within deadline; assuming a dead connection', {
          timeoutMs: this.options.heartbeatTimeoutMs,
        });
        this.terminate(socket);
      }, this.options.heartbeatTimeoutMs);
      this.pongTimer.unref?.();
    }, this.options.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
  }

  /** Drop a socket hard. `terminate` emits `close` even on a half-open TCP session. */
  private terminate(socket: WebSocket): void {
    try {
      if (typeof socket.terminate === 'function') {
        socket.terminate();
      } else {
        socket.close();
      }
    } catch (error) {
      this.options.logger.debug('Mattermost WS: terminate threw', { error });
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    this.attempt += 1;
    const delay = backoffDelay(this.attempt, this.options.minBackoffMs, this.options.maxBackoffMs);
    this.options.logger.info('Mattermost WS: reconnecting', {
      attempt: this.attempt,
      delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((error) => {
        this.options.logger.warn('Mattermost WS: reconnect failed', { error });
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
