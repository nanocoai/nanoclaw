import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { runSkill } from '../lib/skill-driver.js';
import { upsertEnvVar } from '../set-env.js';
import type { GatewayCatalogEntry } from './catalog.js';
import { assertGatewayApplied, selectedGatewayEntry } from './refresh.js';
import { isGatewayInstalled } from './selection.js';

export async function installGateway(
  kind?: string,
  projectRoot = process.cwd(),
  options: { mode?: 'install' | 'refresh'; stamp?: boolean } = {},
): Promise<GatewayCatalogEntry> {
  const entry = selectedGatewayEntry(kind, projectRoot);
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
    assertGatewayApplied(result);
  }
  if (options.stamp !== false) upsertEnvVar('NANOCLAW_GATEWAY_PROVIDER', entry.kind, projectRoot);
  return entry;
}

export function runGatewayAuth(kind: string, agentProvider: string, projectRoot = process.cwd()): void {
  const script = path.join(selectedGatewayEntry(kind, projectRoot).skillPath, 'scripts', 'auth.ts');
  if (!fs.existsSync(script)) throw new Error(`Gateway '${kind}' does not provide an authentication flow`);
  execFileSync('pnpm', ['exec', 'tsx', script, agentProvider], { cwd: projectRoot, stdio: 'inherit' });
}
