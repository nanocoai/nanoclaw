/**
 * Driver-seam migration detector — detect-only, never mutates.
 *
 * The container runtime moved behind the session-driver seam, which breaks
 * three surfaces an install may depend on. This script detects all three in
 * THIS install and prints one finding per line with a minimal fix
 * instruction — hand the output to your coding agent. Nothing detected means
 * nothing to do.
 *
 *   bun scripts/detect-driver-migration.ts     (or: npx tsx …)
 *
 * Surfaces:
 *  1. Group folders the runtime label grammar refuses (≤63 chars of
 *     [A-Za-z0-9_-], alphanumeric at both ends) — these groups cannot spawn.
 *  2. Source customizations importing container helpers that moved into the
 *     driver module (installs are source checkouts, so forks are greppable).
 *  3. Tooling that matches containers by the old `nanoclaw-v2-…` names —
 *     containers are now key-derived `ncl-…`; match by label instead.
 *
 * Exit code: non-zero when anything is found, so it can gate an upgrade.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const findings: string[] = [];

function finding(surface: string, where: string, what: string, fix: string): void {
  findings.push(`BREAKING ${surface} · ${where} · ${what}\n  fix: ${fix}`);
}

// ---- 1. group folders vs the label grammar --------------------------------

const FOLDER_OK = /^[A-Za-z0-9]([A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/;
const groupsDir = path.join(root, 'groups');
if (fs.existsSync(groupsDir)) {
  for (const entry of fs.readdirSync(groupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'global') continue; // reserved, not a group
    if (FOLDER_OK.test(entry.name)) continue;
    finding(
      'group-folder',
      `groups/${entry.name}`,
      'folder name fails the runtime label grammar (≤63 chars of [A-Za-z0-9_-], alphanumeric at both ends) — this group refuses to spawn',
      `stop the host; mv "groups/${entry.name}" to a conforming name; update the agent group row's folder in the central DB to match; restart`,
    );
  }
}

// ---- 2. imports of moved container helpers --------------------------------

const MOVED: Array<[pattern: RegExp, was: string, home: string]> = [
  [
    /\bbuildContainerArgs\b/,
    'buildContainerArgs',
    'composition is composeSessionSpec (src/container-runner.ts); argv assembly is DockerSessionDriver.prepare (src/drivers/docker-driver.ts)',
  ],
  [
    /\bhostGatewayArgs\b/,
    'hostGatewayArgs',
    'network topology is driver-private — see dockerNetworkArgs in src/drivers/index.ts',
  ],
  [
    /\breadonlyMountArgs\b/,
    'readonlyMountArgs',
    "mounts are MountSpecs with mode 'ro' (src/drivers/types.ts), realized by mountArgs (src/drivers/docker-driver.ts)",
  ],
  [/\bstopContainer\b/, 'stopContainer', 'SessionHandle.stop() (src/drivers/types.ts)'],
  [
    /\bensureContainerRuntimeRunning\b/,
    'ensureContainerRuntimeRunning',
    'ensureDockerRunning (src/drivers/docker-driver.ts)',
  ],
  [/\bcleanupOrphans\b/, 'cleanupOrphans', 'SessionDriver.reapResidue (src/drivers/types.ts)'],
];

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(p);
    } else if (entry.name.endsWith('.ts')) {
      yield p;
    }
  }
}

const SELF = path.join('scripts', 'detect-driver-migration.ts');
for (const dir of ['src', 'setup', 'scripts'].map((d) => path.join(root, d))) {
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir)) {
    const rel = path.relative(root, file);
    if (rel === SELF) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Prose about the old world is fine; code that still calls it is not.
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      for (const [pattern, was, home] of MOVED) {
        if (pattern.test(line)) {
          finding(
            'moved-helper',
            `${rel}:${i + 1}`,
            `references '${was}', which no longer exists`,
            `retarget to its new home: ${home}`,
          );
        }
      }
    });
  }
}

// ---- 3. old-name container tooling ----------------------------------------

for (const dir of ['scripts', path.join('.claude', 'skills')].map((d) => path.join(root, d))) {
  if (!fs.existsSync(dir)) continue;
  for (const file of walkAny(dir)) {
    const rel = path.relative(root, file);
    if (rel === SELF) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.includes('nanoclaw-v2') && /docker|--filter\s+name=/.test(line)) {
        finding(
          'container-names',
          `${rel}:${i + 1}`,
          'matches containers by the old nanoclaw-v2-… name; real names are now key-derived ncl-…',
          "match by label instead: docker ps --filter label=nanoclaw-session (any session), --filter label=nanoclaw-group-folder=<folder> (one group's)",
        );
      }
    });
  }
}

function* walkAny(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walkAny(p);
    } else if (/\.(ts|js|sh|md)$/.test(entry.name)) {
      yield p;
    }
  }
}

// Live pre-seam containers (best effort; docker may be absent here).
try {
  const names = execSync('docker ps -a --format "{{.Names}}"', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .split('\n')
    .filter((n) => n.startsWith('nanoclaw-v2-'));
  for (const name of names) {
    finding(
      'container-names',
      `docker: ${name}`,
      'a running pre-seam container; the upgraded host removes these at first startup (they cannot be adopted)',
      'nothing manual required — restart groups via `ncl groups restart` after upgrading if you want them back sooner',
    );
  }
} catch {
  /* no docker here — the two static surfaces above still ran */
}

// ---- report ---------------------------------------------------------------

if (findings.length === 0) {
  console.log('driver-migration: nothing detected — nothing to do.');
  process.exit(0);
}
for (const f of findings) console.log(f);
console.log(
  `\ndriver-migration: ${findings.length} finding(s). Hand this output to your coding agent, or apply the fixes above by hand.`,
);
process.exit(1);
