/** Shared harness for the tmux terminal audit and integration tests. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { TmuxEvidence } from '../tmux-evidence.js';
import { TmuxSession } from '../tmux-session.js';
import { SESSION_TERM_ENV } from '../term-env.js';
import { PROBE_BOOT } from './probe.js';

export const PROBE_PATH = path.join(import.meta.dir, 'probe.ts');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, what: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export function auditSessionEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Container reality: the runner has no terminal parent, so only what the
  // runner itself forces exists. A developer shell's COLORTERM leaking in
  // would fake the env verdict.
  delete env.COLORTERM;
  Object.assign(env, SESSION_TERM_ENV, extra);
  return env;
}

/** Reassemble the byte stream the probe received from its `[rx <hex>]` echoes. */
export function rxBytes(output: string): Buffer {
  const hex: string[] = [];
  for (const m of output.matchAll(/\[rx ([0-9a-f]*)\]/g)) hex.push(m[1]);
  return Buffer.from(hex.join(''), 'hex');
}

export interface TmuxStack {
  session: TmuxSession;
  evidence: TmuxEvidence;
  socketPath: string;
  log(): string;
  rx(): Buffer;
  /** Literal text through the pane's stdin server-side (no client needed). */
  type(text: string): Promise<void>;
  tmux(args: string[]): Promise<{ exitCode: number; stdout: string }>;
  close(): void;
}

export async function startTmuxStack(): Promise<TmuxStack> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-term-audit-tmux-'));
  const socketPath = path.join(dir, 'tmux.sock');
  const logPath = path.join(dir, 'probe.log');
  const session = new TmuxSession({
    command: process.execPath,
    args: [PROBE_PATH],
    cwd: dir,
    env: auditSessionEnv({ PROBE_LOG: logPath }),
    socketPath,
    confPath: path.join(dir, 'tmux.conf'),
    pollMs: 200,
  });
  await session.start();
  const evidence = new TmuxEvidence({ socketPath, pollMs: 200 });
  evidence.start();

  const log = () => {
    try {
      return fs.readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };
  const tmux = async (args: string[]) => {
    const proc = Bun.spawn(['tmux', '-S', socketPath, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, stdout };
  };
  try {
    await waitFor(() => log().includes(PROBE_BOOT), 'the probe boot line in the log');
  } catch (error) {
    evidence.stop();
    session.dispose();
    throw error;
  }
  return {
    session,
    evidence,
    socketPath,
    log,
    rx: () => rxBytes(log()),
    type: async (text) => {
      await tmux(['send-keys', '-t', 'agent', '-l', text]);
    },
    tmux,
    close() {
      evidence.stop();
      session.dispose();
    },
  };
}

export interface TmuxTtyClient {
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  output(): string;
  exited: Promise<number>;
  kill(): void;
}

/** Real tmux client under a test terminal. The explicit SIGWINCH substitutes
 * for delivery by the operator terminal's controlling-terminal machinery. */
export function spawnTmuxClient(socketPath: string, opts: { cols?: number; rows?: number } = {}): TmuxTtyClient {
  const out: Buffer[] = [];
  const terminal = new Bun.Terminal({
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 40,
    name: 'xterm-256color',
    data(_t, chunk) {
      out.push(Buffer.from(chunk));
    },
  });
  // Mirrors the production attach argv (cli/attach-resolve.ts): the exec
  // transport forwards neither TERM nor the locale, so the client restores
  // the color floor and forces UTF-8 itself.
  const proc = Bun.spawn(
    ['env', 'TERM=xterm-256color', 'tmux', '-u', '-S', socketPath, 'attach-session', '-t', 'agent'],
    {
      terminal,
      env: { ...process.env, TERM: 'xterm-256color' },
      onExit() {
        if (!terminal.closed) terminal.close();
      },
    },
  );
  return {
    write: (data) => void terminal.write(data),
    resize: (cols, rows) => {
      terminal.resize(cols, rows);
      try {
        proc.kill('SIGWINCH');
      } catch {
        // client already exited
      }
    },
    output: () => Buffer.concat(out).toString('latin1'),
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}
