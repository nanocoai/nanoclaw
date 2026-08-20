/**
 * Step: environment — Detect OS, Node, container runtimes, existing config.
 * Replaces 01-check-environment.sh
 */
import fs from 'fs';
import path from 'path';

import { log } from '../src/log.js';
import { inspectCentralDb } from './central-db-inspection.js';
import { commandExists, getPlatform, isHeadless, isWSL } from './platform.js';
import { emitStatus } from './status.js';

/**
 * Read a single key from `.env` on disk (not process.env).
 * Returns the trimmed value or null if the key isn't set / file doesn't exist.
 */
export function readEnvKey(key: string, projectRoot?: string): string | null {
  const envPath = path.join(projectRoot ?? process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    if (trimmed.slice(0, eq) === key) {
      return trimmed.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

/**
 * Set (or replace) a single `KEY=value` line in `.env`, creating the file if
 * needed. Non-secret config only — secrets belong in the OneCLI vault.
 */
export function upsertEnvKey(key: string, value: string, projectRoot?: string): void {
  const envPath = path.join(projectRoot ?? process.cwd(), '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    /* no .env yet */
  }
  const line = `${key}=${value}`;
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = line;
  else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(line);
  }
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
}

export async function detectExistingDisplayName(projectRoot: string): Promise<string | null> {
  return (await inspectCentralDb(projectRoot)).displayName;
}

export async function detectRegisteredGroups(projectRoot: string): Promise<boolean> {
  if (fs.existsSync(path.join(projectRoot, 'data', 'registered_groups.json'))) {
    return true;
  }

  return (await inspectCentralDb(projectRoot)).registeredGroups > 0;
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  log.info('Starting environment check');

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();

  // Check Docker
  let docker: 'running' | 'installed_not_running' | 'not_found' = 'not_found';
  if (commandExists('docker')) {
    try {
      const { execSync } = await import('child_process');
      execSync('docker info', { stdio: 'ignore' });
      docker = 'running';
    } catch {
      docker = 'installed_not_running';
    }
  }

  // Check existing config
  const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));

  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  const hasRegisteredGroups = await detectRegisteredGroups(projectRoot);

  // Check for existing OpenClaw installation
  const homedir = (await import('os')).homedir();
  const openClawPath = fs.existsSync(path.join(homedir, '.openclaw'))
    ? path.join(homedir, '.openclaw')
    : fs.existsSync(path.join(homedir, '.clawdbot'))
      ? path.join(homedir, '.clawdbot')
      : null;

  log.info('Environment check complete', {
    platform,
    wsl,
    docker,
    hasEnv,
    hasAuth,
    hasRegisteredGroups,
    openClawPath,
  });

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    DOCKER: docker,
    HAS_ENV: hasEnv,
    HAS_AUTH: hasAuth,
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    OPENCLAW_PATH: openClawPath ?? 'none',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
