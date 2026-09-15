import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { upsertEnvVar } from '../set-env.js';

/**
 * A gateway skill answers "am I the installed one?" by printing `installed`.
 * The probe runs from the project root, because a detector reads that copy's
 * `.env` to identify the installation, independently of service health — even when it is
 * staged elsewhere during an update.
 */
export type GatewayDetector = (script: string) => boolean;

function runDetector(projectRoot: string, script: string): boolean {
  try {
    return (
      execFileSync('pnpm', ['exec', 'tsx', script], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'installed'
    );
  } catch {
    return false;
  }
}

function detectorFor(projectRoot: string, detect?: GatewayDetector): GatewayDetector {
  return detect ?? ((script) => runDetector(projectRoot, script));
}

function configuredKind(projectRoot: string): string {
  try {
    const env = fs.readFileSync(path.join(projectRoot, '.env'), 'utf8');
    return (
      env
        .match(/^NANOCLAW_GATEWAY_PROVIDER=(\S+)$/m)?.[1]
        ?.trim()
        .toLowerCase() ?? ''
    );
  } catch {
    // No .env yet, or unreadable: detection below decides.
    return '';
  }
}

export function isGatewayInstalled(projectRoot: string, skillPath: string, detect?: GatewayDetector): boolean {
  const script = path.join(skillPath, 'scripts', 'detect.ts');
  return fs.existsSync(script) && detectorFor(projectRoot, detect)(script);
}

/** The kind this copy runs: the explicit stamp if there is one, else what is detectably installed. */
export function resolveGatewaySelection(
  projectRoot: string,
  detect?: GatewayDetector,
  skillsRoot = path.join(projectRoot, '.claude', 'skills'),
): string {
  const configured = configuredKind(projectRoot);
  if (configured) return configured;

  const detected = detectInstalledGateway(projectRoot, detect, skillsRoot);
  if (!detected) throw new Error('No installed gateway could be detected; run setup before restarting NanoClaw');
  return detected;
}

/** Resolve, then write the answer down, so the next resolution needs no probing. */
export function ensureExplicitGatewaySelection(projectRoot: string, detect?: GatewayDetector): string {
  const selected = resolveGatewaySelection(projectRoot, detect);
  upsertEnvVar('NANOCLAW_GATEWAY_PROVIDER', selected, projectRoot);
  return selected;
}

export function detectInstalledGateway(
  projectRoot: string,
  detect?: GatewayDetector,
  skillsRoot = path.join(projectRoot, '.claude', 'skills'),
): string | undefined {
  const probe = detectorFor(projectRoot, detect);
  const detected = fs.existsSync(skillsRoot)
    ? fs
        .readdirSync(skillsRoot)
        .filter((name) => name.startsWith('add-'))
        .filter((name) => isGatewayInstalled(projectRoot, path.join(skillsRoot, name), probe))
        .map((name) => name.slice('add-'.length))
    : [];

  if (detected.length > 1) {
    throw new Error(`Multiple installed gateways were detected (${detected.join(', ')}); select one explicitly`);
  }
  return detected[0];
}
