/**
 * The program a session hands its terminal to: the attach client under a
 * pseudo-terminal (node-pty) when the client asked for one, or a plain
 * piped child otherwise. One small interface hides the two so the session
 * handler pumps bytes the same way in both cases.
 */
import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IPty } from 'node-pty';

export interface TerminalSize {
  cols: number;
  rows: number;
  term: string;
}

export interface SpawnSpec {
  bin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface TerminalProgram {
  write(data: Buffer | string): void;
  /** No more input (a plain program's stdin closes; a terminal ignores it). */
  end(): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  pause(): void;
  resume(): void;
  onData(listener: (data: Buffer | string) => void): void;
  /** Plain programs only; a terminal merges both streams. */
  onStderr(listener: (data: Buffer) => void): void;
  onExit(listener: (code: number) => void): void;
}

let helperChecked = false;

/**
 * node-pty spawns through a small helper binary that some package managers
 * unpack without its executable bit; spawning then fails for no visible
 * reason. Restore the bit once per process, where the file is writable.
 */
export function ensureSpawnHelper(): void {
  if (helperChecked) return;
  helperChecked = true;
  try {
    const require = createRequire(import.meta.url);
    const root = path.dirname(path.dirname(require.resolve('node-pty')));
    const candidates = [
      path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(root, 'build', 'Release', 'spawn-helper'),
    ];
    for (const helper of candidates) {
      if (!fs.existsSync(helper)) continue;
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) === 0) fs.chmodSync(helper, (mode | 0o755) & 0o777);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // A helper that cannot be fixed here surfaces as the spawn error itself.
  }
}

/** Run under a pseudo-terminal. The native module loads on first use only. */
export async function spawnPty(spec: SpawnSpec, size: TerminalSize): Promise<TerminalProgram> {
  ensureSpawnHelper();
  const mod = await import('node-pty');
  const spawn = (mod.spawn ?? mod.default.spawn) as typeof mod.spawn;
  const term: IPty = spawn(spec.bin, spec.args, {
    name: size.term || 'xterm-256color',
    cols: Math.max(1, size.cols),
    rows: Math.max(1, size.rows),
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    env: (spec.env ?? process.env) as { [key: string]: string },
  });
  return {
    write: (data) => term.write(data),
    end: () => {},
    resize: (cols, rows) => term.resize(Math.max(1, cols), Math.max(1, rows)),
    kill: (signal) => {
      try {
        term.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
    pause: () => term.pause(),
    resume: () => term.resume(),
    onData: (listener) => term.onData(listener),
    onStderr: () => {},
    // A death by signal arrives as exit code 0 plus the signal number; report it the way shells do.
    onExit: (listener) => term.onExit(({ exitCode, signal }) => listener(signal ? 128 + signal : exitCode)),
  };
}

/** Run with piped stdio (no terminal requested). */
export function spawnPlain(spec: SpawnSpec): TerminalProgram {
  const child = spawnChild(spec.bin, spec.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    env: spec.env ?? process.env,
  });
  return {
    write: (data) => void child.stdin?.write(data),
    end: () => child.stdin?.end(),
    resize: () => {},
    kill: (signal) => void child.kill(signal),
    pause: () => child.stdout?.pause(),
    resume: () => child.stdout?.resume(),
    onData: (listener) => void child.stdout?.on('data', listener),
    onStderr: (listener) => void child.stderr?.on('data', listener),
    onExit: (listener) => {
      child.once('error', () => listener(127));
      child.once('exit', (code, signal) => listener(code ?? (signal ? 128 : 1)));
    },
  };
}
