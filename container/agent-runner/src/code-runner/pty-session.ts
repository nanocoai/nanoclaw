/**
 * The persistent PTY session the code runner owns (sandbox-spec D15, D22).
 *
 * The session is the durable thing; the process inside it is disposable —
 * if the interactive agent process dies, the session respawns it with
 * backoff and tells whoever is attached. Attach clients come and go freely;
 * the ring buffer replays recent output so a fresh attach has context.
 *
 * The PTY itself is Bun.Terminal (native, bun ≥ 1.3.5) behind an injectable
 * spawn factory, so unit tests drive the session with a fake and one
 * integration test exercises the real thing.
 */
export interface PtyLike {
  onData(cb: (data: string | Uint8Array) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pid: number;
}

export type SpawnPty = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyLike;

const defaultSpawn: SpawnPty = (file, args, opts) => {
  const dataCbs = new Set<(data: string | Uint8Array) => void>();
  const exitCbs = new Set<(e: { exitCode: number; signal?: number }) => void>();

  const terminal = new Bun.Terminal({
    cols: opts.cols,
    rows: opts.rows,
    name: opts.name,
    data(_t, chunk) {
      for (const cb of dataCbs) cb(chunk);
    },
  });
  const proc = Bun.spawn([file, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    terminal,
    onExit(_p, exitCode) {
      for (const cb of exitCbs) cb({ exitCode: exitCode ?? -1 });
      // One terminal per child life: the session spawns a fresh PtyLike on
      // respawn, so the dead child's terminal must release its fds here.
      if (!terminal.closed) terminal.close();
    },
  });

  return {
    onData(cb) {
      dataCbs.add(cb);
      return { dispose: () => dataCbs.delete(cb) };
    },
    onExit(cb) {
      exitCbs.add(cb);
      return { dispose: () => exitCbs.delete(cb) };
    },
    write: (data) => terminal.write(data),
    resize: (cols, rows) => {
      terminal.resize(cols, rows);
      // TIOCSWINSZ notifies the pty's foreground process group — but a
      // Bun.Terminal child has no controlling terminal (term-audit:
      // resize-child-notify), so the kernel's SIGWINCH lands nowhere and a
      // TUI never learns its window changed. Deliver it directly; where the
      // kernel does route it, a doubled WINCH is a harmless re-query.
      try {
        proc.kill('SIGWINCH');
      } catch {
        // child already exited; the respawn will get the remembered geometry
      }
    },
    kill: () => proc.kill(),
    pid: proc.pid,
  };
};

export interface PtySessionOptions {
  command: string;
  args: string[];
  /**
   * Args for every life after a FIRST life that ended before healthyRunMs —
   * the C13 resume fallback (see TmuxSession, whose contract this mirrors).
   * Unset leaves respawn behavior exactly as it was.
   */
  fallbackArgs?: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Ring buffer of recent output replayed to a fresh attach. */
  replayBytes?: number;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  /** A run at least this long resets the restart backoff. */
  healthyRunMs?: number;
  /**
   * Fires on EVERY child spawn, respawns included — a respawned child is a
   * fresh boot and per-life state (the mailbox readiness gate's state file)
   * must be reset exactly like first boot.
   */
  onSpawn?: (at: number) => void;
  spawnPty?: SpawnPty;
  now?: () => number;
}

const DEFAULTS = {
  cols: 120,
  rows: 32,
  replayBytes: 256 * 1024,
  restartDelayMs: 1_000,
  maxRestartDelayMs: 30_000,
  healthyRunMs: 30_000,
};

export class PtySession {
  private readonly opts: Required<Omit<PtySessionOptions, 'spawnPty' | 'now' | 'onSpawn' | 'fallbackArgs'>> & {
    spawnPty: SpawnPty;
    now: () => number;
    onSpawn?: (at: number) => void;
    fallbackArgs?: string[];
  };
  private pty: PtyLike | null = null;
  private subs = new Map<number, (chunk: Buffer) => void>();
  private nextSub = 1;
  private ring: Buffer[] = [];
  private ringBytes = 0;
  private cols: number;
  private rows: number;
  private restartDelay: number;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private disposed = false;
  private lives = 0;
  /** Args of the CURRENT and future lives — swapped once by the C13 fallback. */
  private currentArgs: string[];
  private fellBack = false;

  constructor(options: PtySessionOptions) {
    this.opts = { ...DEFAULTS, spawnPty: defaultSpawn, now: () => Date.now(), ...options };
    this.cols = this.opts.cols;
    this.rows = this.opts.rows;
    this.restartDelay = this.opts.restartDelayMs;
    this.currentArgs = this.opts.args;
  }

  start(): void {
    if (this.disposed) throw new Error('PtySession: start() after dispose()');
    if (this.pty) return;
    this.startedAt = this.opts.now();
    this.lives++;
    const pty = this.opts.spawnPty(this.opts.command, this.currentArgs, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.opts.cwd,
      env: this.opts.env,
    });
    this.pty = pty;
    this.opts.onSpawn?.(this.startedAt);
    pty.onData((data) => this.emit(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)));
    pty.onExit(({ exitCode }) => {
      if (this.pty !== pty) return; // stale exit from a killed predecessor
      this.pty = null;
      if (this.disposed) return;
      const healthy = this.opts.now() - this.startedAt >= this.opts.healthyRunMs;
      if (healthy) this.restartDelay = this.opts.restartDelayMs;
      // C13 fallback: a FIRST life that never reached a healthy run is a
      // boot that did not take (a `--continue` over state the CLI cannot
      // load) — swap once, loudly, and boot fresh (see TmuxSession).
      if (!healthy && this.lives === 1 && this.opts.fallbackArgs && !this.fellBack) {
        this.fellBack = true;
        this.currentArgs = this.opts.fallbackArgs;
        console.error('[code-runner] first session life died before its healthy-run window — falling back to fresh-boot args');
      }
      this.emit(
        Buffer.from(
          `\r\n[code-runner] session process exited (code ${exitCode}) — restarting in ${Math.round(this.restartDelay / 1000)}s\r\n`,
          'utf8',
        ),
      );
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.restartDelay = Math.min(this.restartDelay * 2, this.opts.maxRestartDelayMs);
        this.start();
      }, this.restartDelay);
    });
  }

  write(data: Buffer | string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.pty?.resize(cols, rows);
  }

  /** Recent output for replay on attach. */
  replay(): Buffer {
    return Buffer.concat(this.ring);
  }

  subscribe(cb: (chunk: Buffer) => void): () => void {
    const id = this.nextSub++;
    this.subs.set(id, cb);
    return () => this.subs.delete(id);
  }

  get running(): boolean {
    return this.pty !== null;
  }

  /** Spawn time of the CURRENT child life (0 before the first spawn). */
  get lastSpawnAt(): number {
    return this.startedAt;
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const pty = this.pty;
    this.pty = null;
    pty?.kill();
    this.subs.clear();
  }

  private emit(chunk: Buffer): void {
    this.ring.push(chunk);
    this.ringBytes += chunk.length;
    while (this.ringBytes > this.opts.replayBytes && this.ring.length > 1) {
      this.ringBytes -= this.ring[0].length;
      this.ring.shift();
    }
    for (const cb of this.subs.values()) cb(chunk);
  }
}
