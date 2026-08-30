/**
 * Attach-presence evidence from tmux (terminal-architecture: the D14/D17
 * evidence custody moves from the attach server to a tmux adapter).
 *
 * The attach server earned its evidence by owning the socket: every client
 * connect and keystroke passed through it. Under tmux the clients are tmux's,
 * so presence is read back out of the server — `list-clients` exposes
 * per-client created/activity stamps, which are exactly the two human-shaped
 * signals hasLiveAttachEvidence() wants (an exec-shim orphan holds a client
 * open but never types; only activity recency counts).
 *
 * Getter names mirror AttachServer's so index.ts consumes either behind one
 * variable. Input/connect marks are high-water (never reset on detach) —
 * the attach server kept its marks across disconnects for the same reason:
 * "a human was here recently" outlives the connection that proved it.
 *
 * Granularity note (spike Q4): tmux stamps are whole seconds. Every consumer
 * window is ≥10s (COMPOSE_HOLD_MS the tightest), so second-resolution is
 * inside tolerance; the compose-hold test pins that headroom.
 */
import { TMUX_SOCKET_PATH, type TmuxExec, type TmuxExecResult } from './tmux-session.js';

const defaultExec: TmuxExec = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

export interface TmuxEvidenceOptions {
  socketPath?: string;
  pollMs?: number;
  exec?: TmuxExec;
}

export class TmuxEvidence {
  private readonly socketPath: string;
  private readonly pollMs: number;
  private readonly exec: TmuxExec;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private clients = 0;
  private inputHighWater = 0;
  private connectHighWater = 0;
  private liveActivity = 0;

  constructor(options: TmuxEvidenceOptions = {}) {
    this.socketPath = options.socketPath ?? TMUX_SOCKET_PATH;
    this.pollMs = options.pollMs ?? 1_000;
    this.exec = options.exec ?? defaultExec;
  }

  get clientCount(): number {
    return this.clients;
  }

  /** Epoch ms of the newest client keystroke ever observed (0 if none). */
  get lastClientInputAt(): number {
    return this.inputHighWater;
  }

  /** Epoch ms of the newest client connect ever observed (0 if none). */
  get lastClientConnectAt(): number {
    return this.connectHighWater;
  }

  /**
   * Epoch ms of the newest LIVE client's activity stamp — undefined when no
   * client is attached. NOT high-water: this is the connected-client lease's
   * evidence (liveness v2) and must die with the connection it describes,
   * where the marks above deliberately outlive it. A merely-attached client
   * counts here (activity == created reads as the connect): "attached and
   * silent" is exactly the case the lease exists to cover, and the orphan
   * objection does not apply — the client must exist NOW, and a dead ssh
   * leaves no tmux client behind.
   */
  get attachedClientActivityAt(): number | undefined {
    return this.clients > 0 && this.liveActivity > 0 ? this.liveActivity : undefined;
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll — exposed for tests. A missing server reads as zero clients,
   * never as an error: between child lives (or before first spawn) detached
   * is the truthful and the fail-safe answer (absent escalates, D17). */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const res: TmuxExecResult = await this.exec([
        'tmux',
        '-S',
        this.socketPath,
        'list-clients',
        '-F',
        '#{client_created} #{client_activity}',
      ]);
      if (res.exitCode !== 0) {
        this.clients = 0;
        this.liveActivity = 0;
        return;
      }
      const lines = res.stdout.split('\n').filter((line) => line.trim().length > 0);
      this.clients = lines.length;
      // Rebuilt from THIS poll's clients only — a client that vanished takes
      // its live-activity stamp with it (the high-water marks keep theirs).
      let liveActivity = 0;
      for (const line of lines) {
        const [createdRaw, activityRaw] = line.trim().split(/\s+/);
        const created = Number(createdRaw) * 1000;
        const activity = Number(activityRaw) * 1000;
        if (Number.isFinite(created)) this.connectHighWater = Math.max(this.connectHighWater, created);
        // client_activity starts equal to client_created; only count it as
        // INPUT evidence once it moves past the connect stamp, or a mere
        // attach would masquerade as a keystroke. Connect evidence is already
        // carried by the created stamp — same split the attach server kept.
        if (Number.isFinite(activity) && Number.isFinite(created) && activity > created) {
          this.inputHighWater = Math.max(this.inputHighWater, activity);
        }
        if (Number.isFinite(activity)) liveActivity = Math.max(liveActivity, activity);
      }
      this.liveActivity = liveActivity;
    } catch {
      this.clients = 0;
      this.liveActivity = 0;
    } finally {
      this.polling = false;
    }
  }
}
