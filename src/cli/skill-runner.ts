/**
 * Bridge from `ncl skills` to the headless skill engine.
 *
 * The engine (`scripts/skill-headless.ts`) is tsx-run TypeScript outside the
 * compiled host tree, so the host does not import it: it spawns the script and
 * parses the one JSON document it prints. A child process also keeps a
 * minutes-long `pnpm run build` off the host's event loop.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { serviceDefinitionPaths } from '../install-slug.js';
import { log } from '../log.js';
import { isPlainObject } from './skill-report.js';

const execFileAsync = promisify(execFile);

const SCRIPT = 'scripts/skill-headless.ts';
const MAX_OUTPUT = 64 * 1024 * 1024;
/** `list` and `plan` read the checkout and exit. */
const READ_TIMEOUT_MS = 60 * 1000;
/** An apply may build a container image; a hung child must still end eventually. */
const APPLY_TIMEOUT_MS = 60 * 60 * 1000;

function tail(text: string, lines = 12): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

/**
 * The tsx CLI entry, resolved through the checkout's package graph — not the
 * `node_modules/.bin/tsx` shell shim, which looks `node` up on a PATH that a
 * service host (launchd, systemd) rarely has it on.
 */
function tsxCli(root: string): string {
  try {
    return createRequire(path.join(root, 'package.json')).resolve('tsx/cli');
  } catch {
    throw new Error('the skill engine needs tsx (a dev dependency) — run `pnpm install` in the checkout');
  }
}

/**
 * The child environment. A service host's PATH rarely has node or pnpm, so the
 * directories they realistically live in go first — missing ones dropped —
 * followed by whatever PATH the service was started with.
 */
export function engineEnv(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = os.homedir();
  const candidates = [
    // node as launched (argv0 keeps the symlink's dir — under launchd the Homebrew
    // or nvm bin dir, where pnpm sits next to it) and as resolved (execPath).
    path.isAbsolute(process.argv0) ? path.dirname(process.argv0) : '',
    path.dirname(process.execPath),
    env.PNPM_HOME ?? '',
    path.join(home, process.platform === 'darwin' ? 'Library/pnpm' : '.local/share/pnpm'),
    path.join(home, '.local', 'bin'),
    path.join(root, 'node_modules', '.bin'),
  ].filter((dir) => dir && existsSync(dir));
  const prepend = [...new Set(candidates)];
  const rest = (env.PATH ?? '').split(path.delimiter).filter((p) => p && !prepend.includes(p));
  return { ...env, PATH: [...prepend, ...rest].join(path.delimiter) };
}

/** Run one headless engine command and return its parsed JSON output. */
export async function runSkillHeadless<T>(args: string[]): Promise<T> {
  const root = process.cwd();
  let stdout = '';
  let stderr = '';
  try {
    const out = await execFileAsync(process.execPath, [tsxCli(root), SCRIPT, ...args], {
      cwd: root,
      maxBuffer: MAX_OUTPUT,
      timeout: args[0] === 'apply' ? APPLY_TIMEOUT_MS : READ_TIMEOUT_MS,
      env: engineEnv(root),
    });
    stdout = out.stdout;
    stderr = out.stderr;
  } catch (err) {
    // A non-zero exit still carries the engine's JSON (a failed or rolled-back apply).
    const e = err as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    if (!stdout.trim()) throw new Error(`skill engine failed: ${tail(stderr || e.message || 'no output')}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`skill engine returned no JSON: ${tail(stderr || stdout)}`);
  }
  // The engine reports a refused or failed apply as a full report; anything it
  // could not even start (bad arguments, unknown skill) arrives as `{ error }`.
  if (isPlainObject(doc) && typeof doc.error === 'string' && doc.status === undefined) throw new Error(doc.error);
  return doc as T;
}

/**
 * Whether a launchd or systemd definition exists for this checkout — what
 * `setup/lib/restart.sh` acts on. A host started by hand has none, and the
 * script would restart nothing, so the caller reports that instead.
 */
export function hostServiceDefined(): boolean {
  return serviceDefinitionPaths().some((file) => existsSync(file));
}

/** Restart the host service the way `nc:run effect:restart` does — detached, so it survives this process being replaced. */
export function restartHost(): void {
  log.info('Restarting the host to load an applied skill');
  const child = spawn('bash', ['setup/lib/restart.sh'], { cwd: process.cwd(), detached: true, stdio: 'ignore' });
  child.on('error', (err) => log.error('Host restart failed to start', { err }));
  child.unref();
}
