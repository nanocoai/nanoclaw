/**
 * Uninstall the /add-agent-network skill's runtime.
 *
 * Stops + removes the Squid container, removes the egress Docker network,
 * strips the self-registration import from the network barrel, rebuilds
 * dist/, and prints a bounce instruction.
 *
 * `data/squid/` is preserved so re-installing later is fast. Delete it
 * manually for a clean slate. `agent_destinations` rows and
 * `internet_access_policy` blobs are also preserved — they're regular DB
 * state that the skill only consumes, never owns.
 *
 * Usage:
 *   pnpm exec tsx .claude/skills/manage-agent-network/scripts/uninstall.ts
 */
import { execFileSync, execSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

// Run via `pnpm exec tsx .claude/skills/manage-agent-network/scripts/uninstall.ts`
// from the project root — same convention as other skill scripts.
const PROJECT_ROOT = process.cwd();
const NETWORK_BARREL = path.join(PROJECT_ROOT, 'src/modules/network/index.ts');
const PROVIDER_IMPORT = "import './squid-policy-provider.js';";

if (!fs.existsSync(NETWORK_BARREL)) {
  console.error(`ERROR: cannot find ${NETWORK_BARREL}`);
  console.error('Run this script from the NanoClaw project root.');
  process.exit(2);
}

// Match the install-slug-based names the provider uses without depending
// on the in-tree TS module graph (installs may want to uninstall before
// re-running the build). Mirrors src/install-slug.ts:getInstallSlug.
function installSlug(): string {
  return createHash('sha1').update(PROJECT_ROOT).digest('hex').slice(0, 8);
}

const SLUG = installSlug();
const CONTAINER_NAME = `nanoclaw-agent-v2-${SLUG}-squid`;
const NETWORK_NAME = `nanoclaw-agent-v2-${SLUG}-egress`;

function step(label: string, fn: () => void): void {
  process.stdout.write(`==> ${label} ... `);
  try {
    fn();
    process.stdout.write('done\n');
  } catch (err) {
    process.stdout.write('skipped\n');
    if (process.env.NANOCLAW_DEBUG) console.error(`  ${(err as Error).message}`);
  }
}

function dockerOk(args: string[]): boolean {
  try {
    execFileSync('docker', args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function stopAndRemoveContainer(): void {
  if (!dockerOk(['inspect', CONTAINER_NAME])) {
    throw new Error('container not present');
  }
  execFileSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'pipe' });
}

function removeNetwork(): void {
  if (!dockerOk(['network', 'inspect', NETWORK_NAME])) {
    throw new Error('network not present');
  }
  execFileSync('docker', ['network', 'rm', NETWORK_NAME], { stdio: 'pipe' });
}

function stripBarrelImport(): void {
  const current = fs.readFileSync(NETWORK_BARREL, 'utf8');
  if (!current.includes(PROVIDER_IMPORT)) {
    throw new Error('import line not present');
  }
  // Remove the import line and any blank line immediately preceding it that
  // we added on install. Keep the rest of the file intact.
  const without = current
    .split('\n')
    .filter((line, i, arr) => {
      if (line.trim() === PROVIDER_IMPORT) return false;
      // Drop a single blank line right before the import (added by install.ts)
      if (line === '' && arr[i + 1]?.trim() === PROVIDER_IMPORT) return false;
      return true;
    })
    .join('\n');
  fs.writeFileSync(NETWORK_BARREL, without);
}

function rebuildDist(): void {
  fs.rmSync(path.join(PROJECT_ROOT, 'dist'), { recursive: true, force: true });
  execSync('pnpm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
}

function printBounceInstructions(): void {
  console.log('');
  console.log('Uninstall complete. Restart the host so the (now-unregistered) provider is unloaded:');
  console.log('');
  console.log('  macOS:   launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-' + SLUG);
  console.log('  Linux:   systemctl --user restart nanoclaw-v2-' + SLUG);
  console.log('');
  console.log('Preserved (delete manually if you want a clean slate):');
  console.log('  - data/squid/                      (port map + last-generated config)');
  console.log('  - agent_groups.internet_access_policy values');
  console.log('  - agent_destinations rows');
  console.log('');
  console.log('Note: agent containers will continue using their old HTTPS_PROXY env until next spawn.');
}

function main(): void {
  step('Stop and remove Squid container', stopAndRemoveContainer);
  step('Remove egress Docker network', removeNetwork);
  step('Strip provider import from network barrel', stripBarrelImport);
  step('Rebuild dist/', rebuildDist);
  printBounceInstructions();
}

main();
