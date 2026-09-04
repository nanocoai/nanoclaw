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

import { getLaunchdLabel, getSystemdUnit } from '../install-slug.js';
import { log } from '../log.js';
import { isPlainObject } from './skill-report.js';

const execFileAsync = promisify(execFile);

const SCRIPT = 'scripts/skill-headless.ts';
const MAX_OUTPUT = 64 * 1024 * 1024;
/** `list` and `plan` read the checkout and exit. */
const READ_TIMEOUT_MS = 60 * 1000;
/** An apply may build a container image; a hung child must still end eventually. */
const APPLY_TIMEOUT_MS = 60 * 60 * 1000;

// Fast fail for two applies from this host. The lock that also covers the
// setup wizard, /update-skills, and terminal runs is the engine's own,
// checkout-level one (acquireApplyLock in scripts/skill-headless.ts).
let applyInFlight = false;

function tail(text: string, lines = 12): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

/**
 * The tsx CLI entry, resolved through the checkout's package graph — not the
 * `node_modules/.bin/tsx` shell shim, which looks `node` up on PATH, and the
 * PATH a service host gets from launchd or systemd rarely has it.
 */
function tsxCli(root: string): string {
  try {
    return createRequire(path.join(root, 'package.json')).resolve('tsx/cli');
  } catch {
    throw new Error('the skill engine needs tsx (a dev dependency) — run `pnpm install` in the checkout');
  }
}

/**
 * The environment for the engine and the commands it runs (`pnpm`, `git`,
 * `bun`). The service's PATH (launchd, systemd) rarely has node or pnpm, so
 * the directories they realistically live in go first: the node that started
 * this process as it was named (`argv0` — under launchd the Homebrew or nvm
 * bin dir, where pnpm sits next to it; Node rewrites `argv[0]` to the resolved
 * path, so only `argv0` keeps the symlink's directory) and as resolved
 * (`execPath` — the same dir for an npm/corepack pnpm), the pnpm standalone
 * home, `~/.local/bin`, and the checkout's own bin dir. Directories that do not exist are dropped, and
 * whatever PATH the service was started with follows.
 */
export function engineEnv(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = os.homedir();
  const candidates = [
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

async function spawnEngine<T>(args: string[], timeout: number): Promise<T> {
  const root = process.cwd();
  let stdout = '';
  let stderr = '';
  try {
    const out = await execFileAsync(process.execPath, [tsxCli(root), SCRIPT, ...args], {
      cwd: root,
      maxBuffer: MAX_OUTPUT,
      timeout,
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
 * Run one headless engine command and return its parsed JSON output.
 * `exclusive` (apply) refuses to overlap another exclusive run from this host.
 */
export async function runSkillHeadless<T>(args: string[], opts: { exclusive?: boolean } = {}): Promise<T> {
  if (!opts.exclusive) return spawnEngine<T>(args, READ_TIMEOUT_MS);
  if (applyInFlight) throw new Error('another skill apply is already running on this host — wait for it to finish');
  applyInFlight = true;
  try {
    return await spawnEngine<T>(args, APPLY_TIMEOUT_MS);
  } finally {
    applyInFlight = false;
  }
}

/**
 * Whether this checkout has a service definition `setup/lib/restart.sh` can
 * act on: the launchd agent or systemd unit named for the install slug. A host
 * started with `pnpm run dev` or the nohup fallback has none — the script would
 * restart nothing — so the caller reports that instead of claiming a restart.
 */
export function hostServiceDefined(root = process.cwd()): boolean {
  const home = os.homedir();
  const definitions =
    process.platform === 'darwin'
      ? [path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel(root)}.plist`)]
      : [
          path.join(home, '.config', 'systemd', 'user', `${getSystemdUnit(root)}.service`),
          `/etc/systemd/system/${getSystemdUnit(root)}.service`,
        ];
  return definitions.some((file) => existsSync(file));
}

/**
 * Restart the host service through the script channel skills use
 * (`nc:run effect:restart`). Detached, so the restart survives this process
 * being replaced. Callers defer it until their reply has left the host.
 */
export function restartHost(root = process.cwd()): void {
  log.info('Restarting the host to load an applied skill');
  const child = spawn('bash', ['setup/lib/restart.sh'], { cwd: root, detached: true, stdio: 'ignore' });
  child.on('error', (err) => log.error('Host restart failed to start', { err }));
  child.unref();
}
