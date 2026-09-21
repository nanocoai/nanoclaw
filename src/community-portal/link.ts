import { errorCode, portalError } from './errors.js';
import { CONTROL_CHANNEL, MAX_CELL_FRAME_CHARS, Mux, type Frame } from './mux.js';

/**
 * The host's link to its account cell (wss://<portal>/cell/link): the
 * remote-access frame protocol v1 over the WebSocket client that ships with
 * Node 22. Every dial asks for a fresh ticket, says hello as the host leg,
 * pings every 20 s, drops a socket that stays silent for 60 s or does not open
 * within 10 s, and reconnects with jittered exponential backoff (1 s base,
 * 30 s cap). The cell opens a `perks` data channel whose `data` frames carry
 * the perks snapshot and device presence; any other channel kind is refused
 * with `error unsupported`. The `data` frame is the source of truth and
 * `perks.changed` only a hint, acted on when no data frame preceded it. The
 * host sends nothing but hello, ping, and error/close on a data channel. A
 * close with 4403 (device forgotten) means "sign in required": the link stops
 * dialling until it is started again; 4008/4009 are the host's own protocol
 * bugs and are logged before the ordinary backoff. The socket constructor is
 * injectable for tests.
 */
export interface CellTicket {
  ticket: string;
  socketUrl: string;
  expiresIn?: number;
}

export interface LinkEvent {
  event: string;
  code?: string;
  [field: string]: unknown;
}
export type LinkLog = (event: LinkEvent) => void;

/** One `data` frame on the perks channel. */
export interface PerksData {
  snapshot: unknown;
  presence: unknown;
}

export interface LinkSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
  addEventListener(type: 'close', listener: (event: { code?: number }) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}
export type LinkSocketConstructor = new (url: URL, protocols: string[]) => LinkSocket;

export interface CellLinkOptions {
  origin: string;
  /** A fresh ticket for every dial. */
  getTicket(signal: AbortSignal): Promise<CellTicket>;
  /** Every `data` frame on the perks channel: right after hello and on every mirror change. */
  onSnapshot?: (data: PerksData) => void;
  /** The `perks.changed` control frame. */
  onChange?: () => void;
  /** The cell closed with 4403: this device was forgotten. The link stays down until `start()`. */
  onForbidden?: () => void;
  log?: LinkLog;
  caps?: string[];
  ver?: string;
  pingMs?: number;
  pongTimeoutMs?: number;
  handshakeMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  Socket?: LinkSocketConstructor;
  random?: () => number;
  now?: () => number;
}

export const PING_INTERVAL_MS = 20_000;
export const PONG_TIMEOUT_MS = 60_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
/** A socket that stayed open this long resets the backoff counter when it drops. */
export const STABLE_RESET_MS = 30_000;
export const CELL_PATH = '/cell/link';
export const HOST_CAPS = ['perks'];
/** Close codes the cell uses (its WebSocket layer permits only 1000 and 3000–4999). */
export const CLOSE_EXPIRED = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_PROTOCOL = 4008;
export const CLOSE_OVERSIZE = 4009;

const OPEN = 1;

/**
 * Jittered exponential backoff: the window is base * 2^attempt capped at
 * `capMs`; the delay is uniform in [window/2, window]. Pure; inject `random`.
 */
export function computeBackoffDelay(
  attempt: number,
  { baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS, random = Math.random } = {},
): number {
  const window = Math.min(capMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.floor(window / 2 + random() * (window / 2));
}

export class CellLink {
  connected = false;
  private readonly origin: string;
  private readonly getTicket: (signal: AbortSignal) => Promise<CellTicket>;
  private readonly onSnapshot: (data: PerksData) => void;
  private readonly onChange: () => void;
  private readonly onForbidden: () => void;
  private readonly log: LinkLog;
  private readonly caps: string[];
  private readonly ver?: string;
  private readonly pingMs: number;
  private readonly pongTimeoutMs: number;
  private readonly handshakeMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly Socket: LinkSocketConstructor;
  private readonly random: () => number;
  private readonly now: () => number;
  private socket?: LinkSocket;
  private mux?: Mux;
  private stopped = true;
  private connecting = false;
  private attempt = 0;
  private lastPong = 0;
  private openedAt = 0;
  /** A perks `data` frame arrived since the last `perks.changed`, which is then only a hint. */
  private snapshotSeen = false;
  private abort = new AbortController();
  private pinger?: NodeJS.Timeout;
  private handshake?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;

  constructor({
    origin,
    getTicket,
    onSnapshot = () => {},
    onChange = () => {},
    onForbidden = () => {},
    log = () => {},
    caps = HOST_CAPS,
    ver,
    pingMs = PING_INTERVAL_MS,
    pongTimeoutMs = PONG_TIMEOUT_MS,
    handshakeMs = HANDSHAKE_TIMEOUT_MS,
    backoffBaseMs = BACKOFF_BASE_MS,
    backoffCapMs = BACKOFF_CAP_MS,
    Socket = globalThis.WebSocket as unknown as LinkSocketConstructor,
    random = Math.random,
    now = Date.now,
  }: CellLinkOptions) {
    this.origin = origin;
    this.getTicket = getTicket;
    this.onSnapshot = onSnapshot;
    this.onChange = onChange;
    this.onForbidden = onForbidden;
    this.log = log;
    this.caps = caps;
    this.ver = ver;
    this.pingMs = pingMs;
    this.pongTimeoutMs = pongTimeoutMs;
    this.handshakeMs = handshakeMs;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffCapMs = backoffCapMs;
    this.Socket = Socket;
    this.random = random;
    this.now = now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.reconnect);
    this.reconnect = undefined;
    const socket = this.socket;
    this.detach();
    if (socket) closeQuietly(socket, 1000, 'shutdown');
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.socket) return;
    this.connecting = true;
    try {
      const { ticket, socketUrl } = await this.getTicket(this.abort.signal);
      if (this.stopped) return;
      const url = new URL(socketUrl);
      if (
        url.origin !== this.origin.replace(/^http/, 'ws') ||
        url.pathname !== CELL_PATH ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        throw portalError('The cell returned an unexpected socket address.', 'invalid_cell_url');
      this.dial(url, ticket);
    } catch (error) {
      if (!this.stopped) {
        this.log({ event: 'connection_retry', code: errorCode(error) });
        this.retry();
      }
    } finally {
      this.connecting = false;
    }
  }

  /** Nothing goes in the URL: the ticket travels as a subprotocol. */
  private dial(url: URL, ticket: string): void {
    const socket = new this.Socket(url, ['nc-cell', `ticket.${ticket}`]);
    const mux = new Mux((raw) => {
      try {
        socket.send(raw);
      } catch (_error) {
        // A send on a socket that just went away; the close event handles it.
      }
    }, this.log);
    this.socket = socket;
    this.mux = mux;
    this.openedAt = 0;
    this.handshake = setTimeout(() => {
      if (this.socket === socket && socket.readyState !== OPEN) {
        this.log({ event: 'handshake_timeout' });
        this.drop(socket);
      }
    }, this.handshakeMs);
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      clearTimeout(this.handshake);
      this.handshake = undefined;
      this.openedAt = this.now();
      this.lastPong = this.now();
      this.connected = true;
      mux.send(CONTROL_CHANNEL, 'hello', { leg: 'host', caps: this.caps, ...(this.ver ? { ver: this.ver } : {}) });
      this.pinger = setInterval(() => this.beat(socket, mux), this.pingMs);
      this.log({ event: 'connected' });
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data !== 'string' || event.data.length > MAX_CELL_FRAME_CHARS) {
        this.log({ event: 'dropped_invalid_frame', bytes: typeof event.data === 'string' ? event.data.length : -1 });
        return;
      }
      const frame = mux.receive(event.data);
      if (frame) this.handleFrame(mux, frame);
    });
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', (event) => this.drop(socket, event.code));
  }

  private beat(socket: LinkSocket, mux: Mux): void {
    if (this.socket !== socket || socket.readyState !== OPEN) return;
    if (this.now() - this.lastPong > this.pongTimeoutMs) {
      this.log({ event: 'pong_timeout' });
      this.drop(socket);
      return;
    }
    mux.send(CONTROL_CHANNEL, 'ping');
  }

  private handleFrame(mux: Mux, frame: Frame): void {
    if (frame.ch === CONTROL_CHANNEL) {
      if (frame.t === 'pong') this.lastPong = this.now();
      else if (frame.t === 'perks.changed') {
        if (!this.snapshotSeen) this.onChange();
        this.snapshotSeen = false;
      } else if (frame.t === 'error') this.log({ event: 'cell_error', code: String(frame.code ?? 'unknown') });
      // hello, status (presence) and a ping need no host action; the cell answers
      // anything but hello, ping and data-channel error/close with `read_only`.
      return;
    }
    const handler = mux.handlerFor(frame.ch);
    if (frame.t === 'open') {
      if (handler) return;
      if (frame.kind !== 'perks') {
        mux.send(frame.ch, 'error', { code: 'unsupported' });
        return;
      }
      mux.openChannel(frame.ch, { onFrame: (data) => this.perksFrame(mux, data), onTeardown: () => {} });
      return;
    }
    handler?.onFrame(frame);
  }

  private perksFrame(mux: Mux, frame: Frame): void {
    if (frame.t === 'data') {
      this.snapshotSeen = true;
      this.onSnapshot({ snapshot: frame.snapshot, presence: frame.presence });
    } else if (frame.t === 'error') {
      this.log({ event: 'channel_error', code: String(frame.code ?? 'unknown') });
      mux.closeChannel(frame.ch);
    } else if (frame.t === 'end' || frame.t === 'close') mux.closeChannel(frame.ch);
  }

  /**
   * Forget `socket` and schedule a reconnect; a 4403 close stops the link
   * instead. A no-op for a socket already replaced.
   */
  private drop(socket: LinkSocket, closeCode?: number): void {
    if (this.socket !== socket) return;
    const wasConnected = this.connected;
    const stable = this.openedAt > 0 && this.now() - this.openedAt > STABLE_RESET_MS;
    this.detach();
    closeQuietly(socket);
    if (wasConnected) this.log({ event: 'disconnected', ...(closeCode === undefined ? {} : { closeCode }) });
    if (closeCode === CLOSE_FORBIDDEN) {
      this.log({ event: 'forbidden' });
      this.stopped = true;
      this.abort.abort();
      this.onForbidden();
      return;
    }
    if (closeCode === CLOSE_PROTOCOL || closeCode === CLOSE_OVERSIZE) this.log({ event: 'protocol_error', closeCode });
    if (stable) this.attempt = 0;
    this.retry();
  }

  private detach(): void {
    clearInterval(this.pinger);
    clearTimeout(this.handshake);
    this.pinger = undefined;
    this.handshake = undefined;
    this.mux?.reset();
    this.mux = undefined;
    this.socket = undefined;
    this.connected = false;
    this.openedAt = 0;
    this.snapshotSeen = false;
  }

  private retry(): void {
    if (this.stopped) return;
    clearTimeout(this.reconnect);
    const delay = computeBackoffDelay(this.attempt++, {
      baseMs: this.backoffBaseMs,
      capMs: this.backoffCapMs,
      random: this.random,
    });
    this.reconnect = setTimeout(() => void this.connect(), delay);
  }
}

function closeQuietly(socket: LinkSocket, code?: number, reason?: string): void {
  try {
    socket.close(code, reason);
  } catch (_error) {
    // Already closing or closed.
  }
}
