import net from 'node:net';
import type { LinkLog, SshChannel, SshOpen } from '../../../community-portal/link.js';
import type { ChannelHandler, Frame } from '../../../community-portal/mux.js';
import type { Door } from './door.js';

/**
 * One relayed terminal stream: the pipe between an `ssh` channel on the
 * host's link and a loopback TCP connection to the door.
 *
 * The host never listens on the network. A stream arrives as `open` on the
 * outbound link; the pipe connects to the door on 127.0.0.1 from a fresh
 * ephemeral source port, registers what that port is for before the first
 * byte flows (the program the connection lands in looks the port up through
 * the door), then pumps both ways. Flow control is per direction: chunks of
 * at most 16 KiB carrying a running byte offset, a 64 KiB window of
 * unacknowledged bytes, and a `credit` for every chunk delivered to the local
 * socket (its write callback fired), so neither a slow terminal nor a slow
 * door can grow an unbounded queue anywhere. `end` half-closes after the
 * queued bytes; the last bytes of a stream (an exit status, a goodbye) are
 * acknowledged before `close` goes out; a `close` from the far end destroys
 * the socket. A link drop tears the channel down, which destroys the socket
 * and forgets the registration too.
 *
 * Payload bytes are never logged; envelope metadata only.
 */
export const CHUNK_BYTES = 16_384;
export const WINDOW_BYTES = 65_536;
export const CONNECT_TIMEOUT_MS = 5_000;
/** After the door socket closed, how long to wait for the far end to acknowledge the last bytes. */
export const DRAIN_TIMEOUT_MS = 10_000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_B64_CHARS = 4 * Math.ceil(CHUNK_BYTES / 3);

export type StreamCloseReason =
  | 'offline'
  | 'peer'
  | 'unavailable'
  | 'revoked'
  | 'unsupported'
  | 'busy'
  | 'timeout'
  | 'protocol';

/** Decode one `data.b64` field; null unless it is canonical base64 of 1..16 384 bytes. */
export function decodeChunk(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_B64_CHARS || !BASE64.test(value))
    return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length >= 1 && bytes.length <= CHUNK_BYTES ? bytes : null;
}

export interface StreamOptions {
  open: SshOpen;
  channel: SshChannel;
  doorPort: number;
  door: Pick<Door, 'registerTarget' | 'unregisterTarget'>;
  log?: LinkLog;
  /** Test seam: how the loopback connection is made. */
  connect?: (options: net.TcpNetConnectOpts) => net.Socket;
  connectTimeoutMs?: number;
  drainTimeoutMs?: number;
  now?: () => number;
}

/** Start piping one stream; the handler receives the channel's frames and its teardown. */
export function openStream(options: StreamOptions): ChannelHandler {
  const stream = new DoorStream(options);
  return { onFrame: (frame) => stream.onFrame(frame), onTeardown: () => stream.teardown() };
}

class DoorStream {
  private readonly open: SshOpen;
  private readonly channel: SshChannel;
  private readonly door: Pick<Door, 'registerTarget' | 'unregisterTarget'>;
  private readonly log: LinkLog;
  private readonly drainTimeoutMs: number;
  private readonly now: () => number;
  private readonly socket: net.Socket;
  private sourcePort?: number;
  private connected = false;
  private finished = false;
  /** Inbound chunks that arrived before the connection: the target is registered before the first byte. */
  private readonly queue: { bytes: Buffer; ack: number }[] = [];
  private queuedEnd = false;
  // Door → link.
  private sent = 0;
  private acked = 0;
  private doorEnded = false;
  // Link → door.
  private received = 0;
  private delivered = 0;
  private farEnded = false;
  private socketClosed = false;
  private socketError = false;
  private drain?: NodeJS.Timeout;

  constructor({
    open,
    channel,
    doorPort,
    door,
    log = () => {},
    connect = net.connect,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    drainTimeoutMs = DRAIN_TIMEOUT_MS,
    now = Date.now,
  }: StreamOptions) {
    this.open = open;
    this.channel = channel;
    this.door = door;
    this.log = log;
    this.drainTimeoutMs = drainTimeoutMs;
    this.now = now;
    // A fresh ephemeral source port per stream: it is what the door's program
    // sees as the client port and looks the target up by.
    this.socket = connect({
      host: '127.0.0.1',
      port: doorPort,
      localAddress: '127.0.0.1',
      localPort: 0,
      allowHalfOpen: true,
    });
    this.socket.setNoDelay(true);
    this.socket.setTimeout(connectTimeoutMs, () => {
      if (!this.connected) this.socket.destroy();
    });
    this.socket.on('connect', () => this.onConnect());
    this.socket.on('readable', this.pump);
    this.socket.on('end', () => this.onDoorEnd());
    this.socket.on('error', () => {
      this.socketError = true;
    });
    this.socket.on('close', () => this.onSocketClose());
  }

  onFrame(frame: Frame): void {
    if (this.finished) return;
    if (frame.t === 'data') this.onData(frame);
    else if (frame.t === 'credit') this.onCredit(frame);
    else if (frame.t === 'end') this.onFarEnd();
    else if (frame.t === 'close' || frame.t === 'error')
      this.finish({ by: 'far', ...(typeof frame.reason === 'string' ? { reason: frame.reason } : {}) });
    else this.fail('protocol');
  }

  /** The link dropped or the channel was closed under us: no frames can go out any more. */
  teardown(): void {
    this.finish({ by: 'link' });
  }

  private onConnect(): void {
    if (this.finished) return;
    this.socket.setTimeout(0);
    const port = this.socket.localPort;
    if (typeof port !== 'number') return this.fail('unavailable');
    try {
      this.door.registerTarget(port, {
        stream: this.open.stream,
        target: { ...this.open.target },
        source: { ...this.open.source },
        openedAt: new Date(this.now()).toISOString(),
      });
    } catch (error) {
      this.log({ event: 'stream_refused', reason: 'unavailable', stream: this.open.stream, code: String(error) });
      return this.fail('unavailable');
    }
    this.sourcePort = port;
    this.connected = true;
    this.log({
      event: 'stream_open',
      stream: this.open.stream,
      account: this.open.target.account,
      ...(this.open.target.sandbox ? { sandbox: this.open.target.sandbox } : {}),
      sourcePort: port,
      ...(this.open.ticket ? { ticket: this.open.ticket } : {}),
    });
    for (const { bytes, ack } of this.queue.splice(0)) this.deliver(bytes, ack);
    if (this.queuedEnd) this.socket.end();
    this.pump();
  }

  /** Door → link: read what the window allows, at most a chunk at a time. */
  private readonly pump = (): void => {
    if (this.finished || !this.connected) return;
    while (this.socket.readableLength > 0 && this.sent - this.acked < WINDOW_BYTES) {
      const size = Math.min(this.socket.readableLength, CHUNK_BYTES, WINDOW_BYTES - (this.sent - this.acked));
      const bytes = this.socket.read(size) as Buffer | null;
      if (!bytes) break;
      if (!this.channel.send('data', { off: this.sent, b64: bytes.toString('base64') })) return this.fail('protocol');
      this.sent += bytes.length;
    }
    // Reading the last buffered chunk does not itself emit 'end' in paused mode; ask for it.
    if (this.socket.readableLength === 0) this.socket.read(0);
  };

  private onDoorEnd(): void {
    this.doorEnded = true;
    if (!this.finished) this.channel.send('end');
  }

  private onData(frame: Frame): void {
    if (this.socketClosed) return;
    if (this.farEnded) return this.fail('protocol');
    const bytes = decodeChunk(frame.b64);
    if (!bytes || frame.off !== this.received) return this.fail('protocol');
    if (this.received + bytes.length - this.delivered > WINDOW_BYTES) return this.fail('protocol');
    this.received += bytes.length;
    const ack = this.received;
    if (this.connected) this.deliver(bytes, ack);
    else this.queue.push({ bytes, ack });
  }

  /** Credit is returned only once the door has taken the bytes. */
  private deliver(bytes: Buffer, ack: number): void {
    this.socket.write(bytes, (error) => {
      if (error || this.finished) return;
      this.delivered = ack;
      this.channel.send('credit', { ack });
    });
  }

  private onCredit(frame: Frame): void {
    const ack = frame.ack;
    if (typeof ack !== 'number' || !Number.isSafeInteger(ack) || ack < this.acked || ack > this.sent)
      return this.fail('protocol');
    this.acked = ack;
    this.pump();
    this.maybeClose();
  }

  private onFarEnd(): void {
    if (this.farEnded) return;
    this.farEnded = true;
    if (this.connected) this.socket.end();
    else this.queuedEnd = true;
  }

  private onSocketClose(): void {
    this.socketClosed = true;
    if (this.finished) return;
    if (!this.connected) return this.fail('unavailable');
    this.maybeClose();
    if (!this.finished) this.drain = setTimeout(() => this.fail('timeout'), this.drainTimeoutMs);
  }

  /** The door socket is gone: `close` once the far end has acknowledged every byte sent. */
  private maybeClose(): void {
    if (this.finished || !this.socketClosed || this.acked < this.sent) return;
    const reason: StreamCloseReason | undefined = this.socketError && !this.doorEnded ? 'peer' : undefined;
    this.channel.send('close', reason ? { reason } : {});
    this.finish({ by: 'host', ...(reason ? { reason } : {}) });
  }

  private fail(reason: StreamCloseReason): void {
    if (this.finished) return;
    this.channel.send('close', { reason });
    this.finish({ by: 'host', reason });
  }

  private finish({ by, reason }: { by: 'host' | 'far' | 'link'; reason?: string }): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.drain);
    this.socket.off('readable', this.pump);
    this.socket.destroy();
    if (this.sourcePort !== undefined) this.door.unregisterTarget(this.sourcePort);
    this.log({
      event: 'stream_closed',
      stream: this.open.stream,
      by,
      ...(reason ? { reason } : {}),
      bytesIn: this.received,
      bytesOut: this.sent,
    });
    this.channel.release();
  }
}
