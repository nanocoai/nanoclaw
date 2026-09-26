/**
 * Headless gateway selection and code refresh. The /update-nanoclaw
 * controller loads this from a `git archive` extract with no node_modules, so
 * it must not reach the interactive skill driver (clack) or any other package;
 * scripts/update/controller-archive.test.ts enforces that.
 */
import fs from 'node:fs';
import path from 'node:path';

import { applySkill, fullyApplied, type ApplyResult } from '../../scripts/skill-apply.js';
import { channelsRemote, hostExec } from '../lib/skill-host.js';
import { loadGatewayCatalog, type GatewayCatalogEntry } from './catalog.js';
import { configuredGatewayKind, detectInstalledGateway } from './selection.js';

/** The catalog entry for `kind`, else the stamped, detected, or default gateway. */
export function selectedGatewayEntry(kind: string | undefined, projectRoot: string): GatewayCatalogEntry {
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

export function assertGatewayApplied(result: ApplyResult, rawLog?: string): void {
  if (fullyApplied(result)) return;
  const gaps = [...result.deferred, ...result.agentTasks.map((task) => task.reason)];
  const log = rawLog ? ` (command output: ${rawLog})` : '';
  throw new Error(`Gateway skill did not fully apply${gaps.length ? `: ${gaps.join('; ')}` : ''}${log}`);
}

/**
 * Reapply the selected gateway skill's code in refresh mode. Refresh never
 * prompts, walks the operator through anything, or runs services, so it needs
 * no terminal UI. Does not stamp `.env`; the caller owns the selection. Every
 * command and its output go to `rawLog`, which the caller places outside both
 * the live checkout and the tree being refreshed.
 */
export async function refreshGateway(kind: string, projectRoot: string, rawLog: string): Promise<GatewayCatalogEntry> {
  const entry = selectedGatewayEntry(kind, projectRoot);
  fs.mkdirSync(path.dirname(rawLog), { recursive: true });
  fs.writeFileSync(rawLog, `# gateway ${entry.kind} refresh — ${new Date().toISOString()}\n\n`);
  const result = await applySkill(entry.skillPath, projectRoot, {
    mode: 'refresh',
    exec: hostExec(projectRoot, rawLog),
    resolveRemote: channelsRemote(projectRoot),
  });
  assertGatewayApplied(result, rawLog);
  return entry;
}
