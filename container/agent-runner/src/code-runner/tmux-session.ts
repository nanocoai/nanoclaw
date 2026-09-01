/**
 * The tmux-owned interactive session (terminal-architecture: "terminal =
 * tmux, always"). The session lives in a tmux server on a container-private
 * socket; attach is a host-mediated exec into `tmux attach` — resize,
 * redraw, multi-client, detach and scrollback are tmux's, not ours.
 *
 * What this class keeps from PtySession is exactly the surface the mailbox
 * delivery loop consumes (MailboxSession: write / running / lastSpawnAt) plus
 * the per-life respawn contract: the session is the durable thing, the
 * process inside it is disposable. On every child spawn — respawns included —
 * onSpawn fires so per-life state (the mailbox readiness gate's state file)
 * resets exactly like first boot; a respawn mid-ack-wait is detected by
 * lastSpawnAt moving, and the pending claim is released, never acked.
 *
 * Delivery stays byte-faithful to the PTY era: write() feeds the pane's
 * stdin through `send-keys -H` (hex octets), so the bracketed-paste wrapper
 * and the bare-CR nudge arrive as the identical byte sequences the T6-hardened
 * ack machinery was proven against. The paste mechanics change transport;
 * the contract does not.
 *
 * tmux is driven entirely through its CLI behind an injectable exec seam, so
 * unit tests fake the binary and one integration test exercises real tmux.
 */
import fs from 'fs';
import path from 'path';

/** Container-private, like the agent-state file. The host-side attach
 * resolution pins the same literal (src/cli/attach-resolve.ts) — a
 * hand-synced contract, exactly like the attach-socket path before it. */
export const TMUX_SOCKET_PATH = '/tmp/code-runner/tmux.sock';
export const TMUX_SESSION_NAME = 'agent';
const TMUX_CONF_PATH = '/tmp/code-runner/tmux.conf';

/**
 * The generated server config. Only the technical floor lives here — the
 * term-audit matrix over tmux is the acceptance instrument that decides any
 * further polish:
 *  - default-terminal + RGB override: the pane advertises what the PTY-era
 *    SESSION_TERM_ENV advertised (xterm-256color + truecolor), honestly —
 *    tmux re-encodes SGR only when the outer terminal cannot carry it.
 *  - escape-time: tmux's default 500ms ESC disambiguation reads as input lag
 *    inside a TUI that treats bare ESC as a key.
 *  - remain-on-exit: a dead claude leaves the pane (and every attached
 *    client) in place for the respawn watcher instead of tearing the session
 *    down mid-attach.
 *  - status off: the session IS the window here — there are no other tmux
 *    windows to switch between, so a status bar only steals a row and
 *    announces plumbing the operator did not ask to see. With it off the
 *    pane is exactly the client's geometry.
 *  - set-titles + #{pane_title}: the agent's own OSC title (the CLI sets one)
 *    reaches the operator's window/tab instead of tmux's session bookkeeping,
 *    so a remote sandbox names itself like a local session would.
 *  - allow-passthrough / extended-keys / extkeys: the CLI's documented tmux
 *    requirements (code.claude.com/docs/en/terminal-config) — passthrough
 *    lets its desktop notifications and progress reach the outer terminal
 *    instead of being swallowed, and extended keys are what make Shift+Enter
 *    a newline rather than a submit.
 *  - set-clipboard on + the clipboard terminal-feature: tmux's DEFAULT is
 *    'external', which only relays an application's own OSC 52 and leaves
 *    tmux's own copy in a container-private buffer — so selecting text with
 *    the mouse copies nothing to the operator's machine (measured on the
 *    POC). 'on' makes tmux emit OSC 52 itself, which rides the exec stream
 *    and ssh back to the real terminal; the feature declaration is required
 *    because the client's forced TERM carries no Ms capability.
 */
const TMUX_CONF = `set -g default-terminal "xterm-256color"
set -as terminal-overrides ",*:RGB"
set -s escape-time 10
set -g history-limit 100000
set -g focus-events on
set -g mouse on
set -g remain-on-exit on
set -g set-clipboard on
set -ag terminal-features ",xterm-256color:clipboard"
set -g status off
set -g set-titles on
set -g set-titles-string "#{pane_title}"
set -g allow-passthrough on
set -s extended-keys on
set -ag terminal-features ",xterm*:extkeys"
`;

export interface TmuxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Exec seam: run one tmux CLI invocation. `env` is only ever passed on the
 * server-starting call — the server inherits it and panes inherit the server. */
export type TmuxExec = (argv: string[], opts?: { env?: Record<string, string> }) => Promise<TmuxExecResult>;

const defaultExec: TmuxExec = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    env: opts?.env ?? process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/** tmux joins multi-arg shell-commands with spaces and hands them to sh — a
 * respawn re-runs the same string — so each argv token is quoted once here
 * and survives both trips. */
export function shQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export interface TmuxSessionOptions {
  command: string;
  args: string[];
  /**
   * Args for every life after a FIRST life that ended before healthyRunMs —
   * the C13 resume fallback: a boot-time `--continue` the CLI cannot load
   * dies at the gate, and re-running the same argv would crash-loop the
   * session. Unset (the fresh-workspace boot) leaves respawn behavior
   * exactly as it was.
   */
  fallbackArgs?: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  /** A run at least this long resets the restart backoff. */
  healthyRunMs?: number;
  /** Fires on EVERY child spawn, respawns included (per-life state reset). */
  onSpawn?: (at: number) => void;
  socketPath?: string;
  confPath?: string;
  pollMs?: number;
  exec?: TmuxExec;
  now?: () => number;
}

const DEFAULTS = {
  cols: 220,
  rows: 50,
  restartDelayMs: 1_000,
  maxRestartDelayMs: 30_000,
  healthyRunMs: 30_000,
  socketPath: TMUX_SOCKET_PATH,
  confPath: TMUX_CONF_PATH,
  pollMs: 1_000,
};

/** send-keys octets per invocation. Chunking bounds argv size; the write
 * queue serializes chunks so a paste always lands in order. */
const HEX_CHUNK = 256;

export class TmuxSession {
  private readonly opts: Required<Omit<TmuxSessionOptions, 'onSpawn' | 'exec' | 'now' | 'fallbackArgs'>> & {
    onSpawn?: (at: number) => void;
    fallbackArgs?: string[];
    exec: TmuxExec;
    now: () => number;
  };
  private startedAt = 0;
  private restartDelay: number;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private alive = false;
  private disposed = false;
  private checking = false;
  private lives = 0;
  /** Args of the CURRENT and future lives — swapped once by the C13 fallback. */
  private currentArgs: string[];
  private fellBack = false;
  /** Serializes send-keys chunks — delivery order is the paste's integrity. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: TmuxSessionOptions) {
    this.opts = { ...DEFAULTS, exec: defaultExec, now: () => Date.now(), ...options };
    this.restartDelay = this.opts.restartDelayMs;
    this.currentArgs = this.opts.args;
  }

  /** Spawn time of the CURRENT child life (0 before the first spawn). */
  get lastSpawnAt(): number {
    return this.startedAt;
  }

  get running(): boolean {
    return this.alive;
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('TmuxSession: start() after dispose()');
    fs.mkdirSync(path.dirname(this.opts.confPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.opts.confPath, TMUX_CONF);
    await this.spawnSession();
    this.watchTimer = setInterval(() => void this.checkLife(), this.opts.pollMs);
  }

  /** Feed bytes to the pane exactly as the PTY write did — hex octets through
   * send-keys, chunked and strictly ordered. Fire-and-forget like the PTY
   * write; the ack machinery's windows dwarf the CLI round trip. */
  write(data: Buffer | string): void {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const hex: string[] = [];
    for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'));
    for (let i = 0; i < hex.length; i += HEX_CHUNK) {
      const chunk = hex.slice(i, i + HEX_CHUNK);
      this.writeChain = this.writeChain.then(async () => {
        if (this.disposed) return;
        await this.tmux(['send-keys', '-t', TMUX_SESSION_NAME, '-H', ...chunk]);
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.alive = false;
    void this.tmux(['kill-server']);
  }

  private tmux(args: string[], opts?: { env?: Record<string, string> }): Promise<TmuxExecResult> {
    return this.opts.exec(['tmux', '-S', this.opts.socketPath, ...args], opts);
  }

  private paneCommand(): string {
    return [this.opts.command, ...this.currentArgs].map(shQuote).join(' ');
  }

  private async spawnSession(): Promise<void> {
    const res = await this.tmux(
      [
        // Force UTF-8 on the server too: it decides from the locale of
        // whoever starts it, and the runner's env is the container's.
        '-u',
        '-f',
        this.opts.confPath,
        'new-session',
        '-d',
        '-s',
        TMUX_SESSION_NAME,
        '-x',
        String(this.opts.cols),
        '-y',
        String(this.opts.rows),
        '-c',
        this.opts.cwd,
        this.paneCommand(),
      ],
      // The server is born from this client and inherits its env wholesale;
      // panes inherit the server. This is the only call that carries env.
      { env: this.opts.env },
    );
    if (res.exitCode !== 0) {
      throw new Error(`tmux new-session failed (${res.exitCode}): ${res.stderr.trim()}`);
    }
    this.markSpawn();
  }

  private markSpawn(): void {
    this.startedAt = this.opts.now();
    this.alive = true;
    this.lives++;
    this.opts.onSpawn?.(this.startedAt);
  }

  /** One life-watch poll. remain-on-exit keeps a dead claude's pane (and its
   * attached clients) in place; this schedules the respawn with the same
   * backoff contract PtySession carried. */
  private async checkLife(): Promise<void> {
    if (this.disposed || this.checking || this.restartTimer) return;
    this.checking = true;
    try {
      const res = await this.tmux(['list-panes', '-t', TMUX_SESSION_NAME, '-F', '#{pane_dead}']);
      if (this.disposed) return;
      if (res.exitCode !== 0) {
        // Server or session gone entirely (killed, crashed): a full respawn
        // re-creates both. Clients of a killed server are gone regardless.
        this.alive = false;
        this.scheduleRespawn(async () => this.spawnSession());
        return;
      }
      const dead = res.stdout.trim().split('\n')[0] === '1';
      if (!dead) return;
      this.alive = false;
      this.scheduleRespawn(async () => {
        // A bare respawn-pane re-runs the pane's CREATE-time command forever;
        // after the C13 fallback swapped the args, the new command must ride
        // along explicitly or the failing argv would come straight back.
        const respawn = await this.tmux([
          'respawn-pane',
          '-k',
          '-t',
          TMUX_SESSION_NAME,
          ...(this.fellBack ? [this.paneCommand()] : []),
        ]);
        if (respawn.exitCode !== 0) {
          // The session itself may have died between polls — fall through to
          // the full path on the next check rather than looping here.
          console.error(`[code-runner] tmux respawn-pane failed: ${respawn.stderr.trim()}`);
          return;
        }
        this.markSpawn();
      });
    } catch (error) {
      console.error('[code-runner] tmux life-check failed:', error);
    } finally {
      this.checking = false;
    }
  }

  private scheduleRespawn(action: () => Promise<void>): void {
    if (this.restartTimer) return;
    const healthy = this.opts.now() - this.startedAt >= this.opts.healthyRunMs;
    if (healthy) this.restartDelay = this.opts.restartDelayMs;
    // C13 fallback: a FIRST life that never reached a healthy run is a boot
    // that did not take — with `--continue` in the argv that means state the
    // CLI cannot load, and every retry would die the same death. Swap once,
    // loudly, and boot fresh; a healthy first life keeps its argv for good.
    if (!healthy && this.lives === 1 && this.opts.fallbackArgs && !this.fellBack) {
      this.fellBack = true;
      this.currentArgs = this.opts.fallbackArgs;
      console.error('[code-runner] first session life died before its healthy-run window — falling back to fresh-boot args');
    }
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, this.opts.maxRestartDelayMs);
    console.error(`[code-runner] session process exited — respawning in ${Math.round(delay / 1000)}s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed) return;
      void action().catch((error) => console.error('[code-runner] tmux respawn failed:', error));
    }, delay);
  }
}
