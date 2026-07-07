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

import { DATA_DIR } from './config.js';
import { log } from './log.js';

export interface UpgradeState {
  version: string;
  updatedAt: string;
  via: string;
}

const MARKER_PATH = path.join(DATA_DIR, 'upgrade-state.json');
const FIX_COMMAND = 'pnpm exec tsx scripts/upgrade-state.ts set';

/** Version the running code declares, read from package.json. */
export function getCodeVersion(): string {
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (!pkg.version) throw new Error(`No version field in ${pkgPath}`);
  return pkg.version;
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
export function writeUpgradeState(opts: { version?: string; via: string }): UpgradeState {
  const state: UpgradeState = {
    version: opts.version ?? getCodeVersion(),
    updatedAt: new Date().toISOString(),
    via: opts.via,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MARKER_PATH, JSON.stringify(state, null, 2) + '\n');
  return state;
}

/** True when the marker exists and matches the running code version. */
export function isUpgradeCurrent(): boolean {
  const state = readUpgradeState();
  return state !== null && state.version === getCodeVersion();
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

  const code = getCodeVersion();
  const recorded = readUpgradeState()?.version ?? 'none';

  console.error(
    [
      '',
      '='.repeat(64),
      'NanoClaw stopped: update did not go through the supported path',
      '='.repeat(64),
      'This install was updated outside the sanctioned upgrade flow',
      '(no upgrade marker, or the marker version does not match the code).',
      '',
      `  code version:     ${code}`,
      `  recorded version: ${recorded}`,
      '',
      "IF YOU'RE A HUMAN: you most likely ran `git pull` directly. Don't",
      'fix this by hand — open Claude Code in this folder and run',
      '/update-nanoclaw, which repairs the install and clears this stop.',
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
