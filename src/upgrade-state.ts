/**
 * Upgrade marker — the record that an install reached its current version
 * through a sanctioned path (setup / `/update-nanoclaw` / `/migrate-nanoclaw`).
 *
 * The startup tripwire (enforceUpgradeTripwire) refuses to run if the marker
 * is missing or its version doesn't match the running code — i.e. if the
 * install was updated by a raw `git pull` instead of the supported flow.
 *
 * The marker lives in `data/` (gitignored), so a `git pull` can't touch it.
 * Only the sanctioned paths call writeUpgradeState(); clearing the tripwire
 * by hand is the same `set` — see docs/upgrade-recovery.md.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

export interface UpgradeState {
  version: string;
  commit: string;
  tree: string;
  updatedAt: string;
  via: string;
}

export interface CodeIdentity {
  version: string;
  commit: string;
  tree: string;
}

const MARKER_PATH = path.join(DATA_DIR, 'upgrade-state.json');
const FIX_COMMAND = 'pnpm exec tsx scripts/upgrade-state.ts set';

/** Version the running code declares, read from package.json. */
export function getCodeVersion(projectRoot: string = process.cwd()): string {
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (!pkg.version) throw new Error(`No version field in ${pkgPath}`);
  return pkg.version;
}

/** Git identity of the exact checkout the host is about to run. */
export function getCodeIdentity(projectRoot: string = process.cwd()): CodeIdentity {
  const git = (rev: string): string =>
    execFileSync('git', ['rev-parse', '--verify', rev], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

  const version = getCodeVersion(projectRoot);
  try {
    return { version, commit: git('HEAD'), tree: git('HEAD^{tree}') };
  } catch {
    return { version, commit: 'unknown', tree: 'unknown' };
  }
}

/**
 * Read the upgrade marker, or null if it's absent, unreadable, or corrupt.
 * Never throws — a boot gate must fail closed (treat anything it can't trust
 * as "no valid marker" → trip), not crash with a stack trace.
 */
export function readUpgradeState(): UpgradeState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(MARKER_PATH, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log.warn('Could not read upgrade marker; treating as absent', { path: MARKER_PATH, err: String(e) });
    return null;
  }
  try {
    return JSON.parse(raw) as UpgradeState;
  } catch {
    log.warn('Upgrade marker is corrupt; treating as absent', { path: MARKER_PATH });
    return null;
  }
}

/**
 * Stamp the marker. Only the sanctioned paths (setup / update / migrate)
 * call this on success; `version` defaults to the current code version.
 */
export function writeUpgradeState(opts: { version?: string; via: string; projectRoot?: string }): UpgradeState {
  const identity = getCodeIdentity(opts.projectRoot);
  const state: UpgradeState = {
    ...identity,
    version: opts.version ?? identity.version,
    updatedAt: new Date().toISOString(),
    via: opts.via,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MARKER_PATH, JSON.stringify(state, null, 2) + '\n');
  return state;
}

/** True when the marker exists and matches the exact running checkout. */
export function isUpgradeCurrent(projectRoot: string = process.cwd()): boolean {
  const state = readUpgradeState();
  if (state === null) return false;
  try {
    const code = getCodeIdentity(projectRoot);
    return state.version === code.version && state.commit === code.commit && state.tree === code.tree;
  } catch (err) {
    log.warn('Could not resolve running code identity; upgrade marker fails closed', {
      err: String(err),
    });
    return false;
  }
}

/** Absolute path to the marker file. */
export function markerPath(): string {
  return MARKER_PATH;
}

/**
 * Startup gate. If the install didn't reach the current version through a
 * sanctioned path, stop with a message written for the coding agent that
 * just ran the upgrade to act on automatically.
 */
export function enforceUpgradeTripwire(): void {
  if (isUpgradeCurrent()) return;

  const code = getCodeIdentity();
  const recorded = readUpgradeState();
  const gitUnavailable = code.commit === 'unknown' || code.tree === 'unknown';
  const exactCheckoutChanged =
    recorded !== null &&
    recorded.version === code.version &&
    (recorded.commit !== code.commit || recorded.tree !== code.tree);
  const humanGuidance = gitUnavailable
    ? [
        'Git could not identify this checkout. Restore Git access, then run',
        '/update-nanoclaw. If a supported update already completed, the coding',
        `agent can use the recovery command below even while Git is unavailable.`,
      ]
    : exactCheckoutChanged
      ? [
          'The code changed without a matching update record. This can happen',
          'after pulling upstream changes or committing a local customization.',
          'Run /update-nanoclaw for upstream changes. For an intentional local',
          'commit, follow the local-customization steps in the recovery guide.',
        ]
      : [
          "You most likely ran `git pull` directly. Don't fix this by hand —",
          'open Claude Code in this folder and run /update-nanoclaw, which',
          'repairs the install and clears this stop.',
        ];

  console.error(
    [
      '',
      '='.repeat(64),
      'NanoClaw stopped: update did not go through the supported path',
      '='.repeat(64),
      'This install was updated outside the sanctioned upgrade flow',
      '(no upgrade marker, or its version/commit/tree does not match the code).',
      '',
      `  code version:     ${code?.version ?? 'unknown'}`,
      `  code commit:      ${code?.commit ?? 'unknown'}`,
      `  recorded version: ${recorded?.version ?? 'none'}`,
      `  recorded commit:  ${recorded?.commit ?? 'none'}`,
      '',
      "IF YOU'RE A HUMAN:",
      ...humanGuidance,
      '',
      'CODING AGENT: if you just ran /update-nanoclaw, /migrate-nanoclaw, or',
      'setup and it completed successfully, clear this automatically by running:',
      '',
      `  ${FIX_COMMAND}`,
      '',
      'then restart NanoClaw. If the upgrade did NOT complete, stop and',
      'investigate instead of clearing.',
      '',
      'Details: docs/upgrade-recovery.md',
      '='.repeat(64),
      '',
    ].join('\n'),
  );
  log.error('Upgrade tripwire: install not on the sanctioned path', { code, recorded });
  process.exit(1);
}
