/**
 * scripts/upgrade-state.ts — read or stamp the upgrade marker.
 *
 * Usage:
 *   pnpm exec tsx scripts/upgrade-state.ts get
 *   pnpm exec tsx scripts/upgrade-state.ts set [version] [via]
 *
 * `set` with no version stamps the current package.json version. The
 * sanctioned upgrade paths (setup / update / migrate) call `set` on
 * success; running it by hand is also the documented way to clear the
 * startup tripwire — see docs/upgrade-recovery.md.
 */
import { getCodeVersion, markerPath, readUpgradeState, writeUpgradeState } from '../src/upgrade-state.js';

const [, , cmd, versionArg, viaArg] = process.argv;

if (cmd === 'get') {
  const state = readUpgradeState();
  console.log(state ? JSON.stringify(state) : 'none');
} else if (cmd === 'set') {
  const state = writeUpgradeState({ version: versionArg || getCodeVersion(), via: viaArg || 'manual' });
  console.log(`Stamped ${markerPath()}: ${JSON.stringify(state)}`);
} else {
  console.error('Usage: pnpm exec tsx scripts/upgrade-state.ts get | set [version] [via]');
  process.exit(2);
}
