import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fullyApplied } from '../../scripts/skill-apply.js';
import { runSkill } from '../lib/skill-driver.js';
import { upsertEnvVar } from '../set-env.js';
import { loadGatewayCatalog, type GatewayCatalogEntry } from './catalog.js';
import { configuredGatewayKind, detectInstalledGateway, isGatewayInstalled } from './selection.js';

function selectedEntry(kind: string | undefined, projectRoot: string): GatewayCatalogEntry {
  const catalog = loadGatewayCatalog(projectRoot);
  const selected =
    kind?.trim().toLowerCase() ||
    configuredGatewayKind(projectRoot) ||
    detectInstalledGateway(projectRoot) ||
    catalog.default;
  const entry = catalog.gateways.find((candidate) => candidate.kind === selected);
  if (!entry) throw new Error(`Unknown gateway provider: ${selected}`);
  return entry;
}

export async function installGateway(
  kind?: string,
  projectRoot = process.cwd(),
  options: { mode?: 'install' | 'refresh'; stamp?: boolean } = {},
): Promise<GatewayCatalogEntry> {
  const entry = selectedEntry(kind, projectRoot);
  // Live setup first refreshes owned payloads, then reconciles services.
  // Transactional updates explicitly request refresh and never run services here.
  const modes: ('install' | 'refresh')[] = options.mode
    ? [options.mode]
    : isGatewayInstalled(projectRoot, entry.skillPath)
      ? ['refresh', 'install']
      : ['install'];
  for (const mode of modes) {
    const result = await runSkill(entry.skillPath, {
      projectRoot,
      channel: 'gateway',
      step: entry.kind,
      mode,
    });
    if (!fullyApplied(result)) {
      const gaps = [...result.deferred, ...result.agentTasks.map((task) => task.reason)];
      throw new Error(`Gateway skill did not fully apply${gaps.length ? `: ${gaps.join('; ')}` : ''}`);
    }
  }
  if (options.stamp !== false) upsertEnvVar('NANOCLAW_GATEWAY_PROVIDER', entry.kind, projectRoot);
  return entry;
}

export function runGatewayAuth(kind: string, agentProvider: string, projectRoot = process.cwd()): void {
  const script = path.join(selectedEntry(kind, projectRoot).skillPath, 'scripts', 'auth.ts');
  if (!fs.existsSync(script)) throw new Error(`Gateway '${kind}' does not provide an authentication flow`);
  execFileSync('pnpm', ['exec', 'tsx', script, agentProvider], { cwd: projectRoot, stdio: 'inherit' });
}
