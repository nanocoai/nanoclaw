/**
 * Attach server — a unix socket inside the container (sandbox-spec D22).
 *
 * The socket is container-private (under /tmp, never a shared mount): every
 * attach is host-mediated — the host execs the attach client into the
 * container, so reaching the PTY always goes through the host's door and
 * inherits its auth story (D20). Nothing about the socket assumes who is on
 * the other end beyond that.
 *
 * Multiple clients may attach; all see the same stream, any may type
 * (single-operator assumption, D20). Last resize wins.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import {
  FRAME_DATA,
  FRAME_DETACH,
  FRAME_RESIZE,
  FrameParser,
  KEEPALIVE_DEADLINE_INTERVALS,
  resolveHeartbeatMs,
} from './protocol.js';
import type { PtySession } from './pty-session.js';

export const ATTACH_SOCKET_PATH = '/tmp/code-runner/attach.sock';

/** A wedged client must not balloon the runner; drop it, it can re-attach. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface AttachServerOptions {
  /** Drop a client whose last frame (any type) is older than this.
   *  Default: KEEPALIVE_DEADLINE_INTERVALS × the shared beat cadence. */
  keepaliveDeadlineMs?: number;
  /** How often the deadline sweep runs. Default: the beat cadence. */
  sweepIntervalMs?: number;
  now?: () => number;
}

export class AttachServer {
  private server: net.Server | null = null;
  private readonly clients = new Set<net.Socket>();
  /** Arrival stamp of the last frame (ANY type) per client — sweep fodder,
   *  never attach evidence. */
  private readonly lastFrameAt = new Map<net.Socket, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastInputAt = 0;
  private lastConnectAt = 0;

  constructor(
    private readonly session: PtySession,
    private readonly socketPath: string = ATTACH_SOCKET_PATH,
    /** Fired with the new count on every connect/disconnect — the code runner
     *  stamps it to the attach-state file so hook subprocesses (which cannot
     *  reach this object) can tell attached from detached (D17). */
    private readonly onClientsChanged?: (count: number) => void,
    private readonly options: AttachServerOptions = {},
  ) {}

  /** Epoch ms of the last client keystroke (0 if none) — the mailbox loop holds injection while a human is composing. */
  get lastClientInputAt(): number {
    return this.lastInputAt;
  }

  /** Epoch ms of the most recent client connect (0 if none) — attach evidence for the liveness lease. */
  get lastClientConnectAt(): number {
    return this.lastConnectAt;
  }

  async listen(): Promise<void> {
    const dir = path.dirname(this.socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A stale socket from a previous run of this same container refuses new
    // binds; nothing else legitimately owns this path.
    fs.rmSync(this.socketPath, { force: true });

    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    fs.chmodSync(this.socketPath, 0o600);

    // The keepalive sweep: socket close is the ONLY other disconnect signal,
    // and an orphaned exec's client (or a wedged client process) never sends
    // one — its socket sits open and attach-state.clients overstates forever
    // (term-audit: orphan-socket-sweep). The client pings every beat
    // (protocol.ts FRAME_PING); anyone silent past the deadline is dropped —
    // the same destroy path backpressure already uses; a live client just
    // re-attaches.
    const beat = resolveHeartbeatMs();
    const deadlineMs = this.options.keepaliveDeadlineMs ?? beat * KEEPALIVE_DEADLINE_INTERVALS;
    const sweepMs = this.options.sweepIntervalMs ?? beat;
    this.sweepTimer = setInterval(() => this.sweep(deadlineMs), sweepMs);
    this.sweepTimer.unref?.();
  }

  private sweep(deadlineMs: number): void {
    const now = (this.options.now ?? Date.now)();
    for (const [socket, at] of this.lastFrameAt) {
      if (now - at > deadlineMs) socket.destroy();
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    this.lastFrameAt.clear();
    this.server?.close();
    this.server = null;
    fs.rmSync(this.socketPath, { force: true });
    this.onClientsChanged?.(0);
  }

  private accept(socket: net.Socket): void {
    this.clients.add(socket);
    const now = (this.options.now ?? Date.now)();
    this.lastFrameAt.set(socket, now); // a fresh connect earns a full deadline
    this.lastConnectAt = Date.now();
    this.onClientsChanged?.(this.clients.size);
    const parser = new FrameParser();

    socket.write(this.session.replay());
    const unsubscribe = this.session.subscribe((chunk) => {
      if (socket.writableLength > MAX_BUFFERED_BYTES) {
        socket.destroy();
        return;
      }
      socket.write(chunk);
    });

    socket.on('data', (chunk) => {
      // Any inbound bytes prove the client PROCESS is alive — sweep fodder
      // only, refreshed before parsing so a partial frame still counts.
      this.lastFrameAt.set(socket, (this.options.now ?? Date.now)());
      let frames;
      try {
        frames = parser.push(chunk);
      } catch (error) {
        console.error('[code-runner] dropping attach client:', error);
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === FRAME_DATA) {
          this.lastInputAt = Date.now();
          this.session.write(frame.data);
        } else if (frame.type === FRAME_RESIZE) this.session.resize(frame.resize.cols, frame.resize.rows);
        else if (frame.type === FRAME_DETACH) socket.end();
        // FRAME_PING: keepalive only, already stamped above. It must NEVER
        // touch lastInputAt/lastConnectAt — those feed decideLiveness and
        // hasLiveAttachEvidence (agent-state.ts) as HUMAN evidence for the
        // D14 lease and D17 boundary routing; machine chatter counting as
        // presence would recreate cycle-1's orphan-exec immortality.
      }
    });

    const cleanup = () => {
      unsubscribe();
      this.lastFrameAt.delete(socket);
      // 'close' and 'error' can both fire for one socket; only the firing
      // that actually removed it reports a count change.
      if (this.clients.delete(socket)) this.onClientsChanged?.(this.clients.size);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }
}
