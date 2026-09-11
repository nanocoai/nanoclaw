/**
 * Door supervisor — runs the OpenSSH server under the host process.
 *
 * The server is spawned through the liveness wrapper with a stdin pipe the
 * host holds: closing it (deliberately, or by the host dying) stops the
 * server. A crash is restarted with backoff; a server that keeps dying is
 * left down and reported through `status()` rather than restarted forever.
 * Its stderr (`-e`, LogLevel VERBOSE) is relayed line by line to the host log.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';

export type DoorLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DoorSupervisorOptions {
  sshd: string;
  configFile: string;
  port: number;
  /** argv of the liveness wrapper; the sshd path and config file are appended. */
  wrapper: string[];
  log: (level: DoorLogLevel, message: string, data?: Record<string, unknown>) => void;
  /** Consecutive crash restarts before the supervisor gives up. */
  maxRestarts?: number;
  /** Uptime after which the crash counter resets. */
  restartWindowMs?: number;
  /** How long a fresh server may take to accept on its port. */
  readyTimeoutMs?: number;
}

export interface DoorSupervisorStatus {
  running: boolean;
  pid?: number;
  port: number;
  startedAt?: string;
  restarts: number;
  lastExit?: { code: number | null; signal: string | null; at: string };
  /** Set when the supervisor stopped restarting a crashing server. */
  failure?: string;
}

const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 8_000;
const STDERR_TAIL = 20;

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

export class DoorSupervisor {
  private child?: ChildProcess;
  private stopping = false;
  private restarts = 0;
  private restartTimer?: NodeJS.Timeout;
  private startedAt?: string;
  private lastExit?: DoorSupervisorStatus['lastExit'];
  private failure?: string;
  private readonly stderrTail: string[] = [];

  constructor(private readonly options: DoorSupervisorOptions) {}

  /** Validate the config with `sshd -t`, spawn, and wait until the port accepts. */
  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    this.failure = undefined;
    this.restarts = 0;
    await this.validateConfig();
    await this.spawnServer();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      // Closing the pipe is the stop signal the wrapper watches for.
      child.stdin?.end();
    });
    this.child = undefined;
  }

  status(): DoorSupervisorStatus {
    return {
      running: this.child !== undefined,
      ...(this.child?.pid !== undefined ? { pid: this.child.pid } : {}),
      port: this.options.port,
      ...(this.startedAt && this.child ? { startedAt: this.startedAt } : {}),
      restarts: this.restarts,
      ...(this.lastExit ? { lastExit: this.lastExit } : {}),
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }

  private validateConfig(): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.options.sshd, ['-t', '-f', this.options.configFile], (error, _stdout, stderr) => {
        if (!error) return resolve();
        reject(new Error(`sshd rejected the door configuration: ${stderr.trim() || error.message}`, { cause: error }));
      });
    });
  }

  private async spawnServer(): Promise<void> {
    const [bin, ...args] = this.options.wrapper;
    const child = spawn(bin, [...args, this.options.sshd, this.options.configFile], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.child = child;
    this.startedAt = new Date().toISOString();
    this.stderrTail.length = 0;
    child.stdin?.on('error', () => {
      // EPIPE once the wrapper is gone — the exit handler owns that case.
    });
    if (child.stderr) {
      readline.createInterface({ input: child.stderr }).on('line', (line) => this.relay(line));
    }
    child.on('error', (error) => this.options.log('error', 'Remote terminal door failed to spawn', { err: error }));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    await this.waitReady(child);
  }

  private relay(line: string): void {
    this.stderrTail.push(line);
    if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
    const notable = /Accepted publickey|Server listening|Disconnected from|error|fatal/i.test(line);
    this.options.log(notable ? 'info' : 'debug', 'sshd', { line });
  }

  private waitReady(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const fail = (reason: string): void => {
        child.kill('SIGKILL');
        reject(new Error(`${reason}${this.stderrTail.length ? `\n${this.stderrTail.join('\n')}` : ''}`));
      };
      const tick = async (): Promise<void> => {
        if (child.exitCode !== null || child.signalCode !== null) return fail('the door server exited during startup');
        if (await probePort(this.options.port)) return resolve();
        if (Date.now() >= deadline) return fail(`the door server did not accept on 127.0.0.1:${this.options.port}`);
        setTimeout(() => void tick(), 100);
      };
      void tick();
    });
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.lastExit = { code, signal, at: new Date().toISOString() };
    if (this.stopping) return;
    const uptimeMs = Date.now() - Date.parse(this.startedAt ?? this.lastExit.at);
    if (uptimeMs >= (this.options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS)) this.restarts = 0;
    const max = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    if (this.restarts >= max) {
      this.failure = `the door server exited ${max + 1} times in a row; not restarting (ncl sandboxes remote enable restarts it)`;
      this.options.log('error', 'Remote terminal door gave up restarting', { code, signal, tail: this.stderrTail });
      return;
    }
    const delayMs = Math.min(30_000, 1000 * 2 ** this.restarts);
    this.restarts += 1;
    this.options.log('warn', 'Remote terminal door exited; restarting', { code, signal, delayMs });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      this.spawnServer().catch((error: unknown) => {
        this.options.log('error', 'Remote terminal door restart failed', { err: error });
        this.onExit(this.child ?? child, null, null);
      });
    }, delayMs);
  }
}
