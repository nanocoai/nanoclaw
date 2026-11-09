/**
 * Step: mounts — Write mount allowlist config file.
 * Replaces 07-configure-mounts.sh
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

import { log } from '../src/log.js';
import { isRoot } from './platform.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { empty: boolean; json: string; force: boolean } {
  let empty = false;
  let json = '';
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--empty') empty = true;
    if (args[i] === '--force') force = true;
    if (args[i] === '--json' && args[i + 1]) {
      json = args[i + 1];
      i++;
    }
  }
  return { empty, json, force };
}

export async function run(args: string[]): Promise<void> {
  const { empty, json, force } = parseArgs(args);
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.config', 'nanoclaw');
  const configFile = path.join(configDir, 'mount-allowlist.json');

  if (isRoot()) {
    log.warn('Running as root — mount allowlist will be written to root home directory');
  }

  fs.mkdirSync(configDir, { recursive: true });

  if (fs.existsSync(configFile) && !force) {
    log.info('Mount allowlist already exists — skipping (use --force to overwrite)', { configFile });
    emitStatus('CONFIGURE_MOUNTS', {
      PATH: configFile,
      ALLOWED_ROOTS: 0,
      NON_MAIN_READ_ONLY: 'unknown',
      STATUS: 'skipped',
      LOG: 'logs/setup.log',
    });
    return;
  }

  let allowedRoots = 0;
  let nonMainReadOnly = 'true';

  if (empty) {
    log.info('Writing empty mount allowlist');
    const emptyConfig = {
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(configFile, JSON.stringify(emptyConfig, null, 2) + '\n');
  } else if (json) {
    // Validate JSON with JSON.parse (not piped through shell)
    let parsed: { allowedRoots?: unknown[]; nonMainReadOnly?: boolean };
    try {
      parsed = JSON.parse(json);
    } catch {
      log.error('Invalid JSON input');
      emitStatus('CONFIGURE_MOUNTS', {
        PATH: configFile,
        ALLOWED_ROOTS: 0,
        NON_MAIN_READ_ONLY: 'unknown',
        STATUS: 'failed',
        ERROR: 'invalid_json',
        LOG: 'logs/setup.log',
      });
      process.exit(4);
      return; // unreachable but satisfies TS
    }

    fs.writeFileSync(configFile, JSON.stringify(parsed, null, 2) + '\n');
    allowedRoots = Array.isArray(parsed.allowedRoots) ? parsed.allowedRoots.length : 0;
    nonMainReadOnly = parsed.nonMainReadOnly === false ? 'false' : 'true';
  } else {
    // Read from stdin
    log.info('Reading mount allowlist from stdin');
    const input = fs.readFileSync(0, 'utf-8');
    let parsed: { allowedRoots?: unknown[]; nonMainReadOnly?: boolean };
    try {
      parsed = JSON.parse(input);
    } catch {
      log.error('Invalid JSON from stdin');
      emitStatus('CONFIGURE_MOUNTS', {
        PATH: configFile,
        ALLOWED_ROOTS: 0,
        NON_MAIN_READ_ONLY: 'unknown',
        STATUS: 'failed',
        ERROR: 'invalid_json',
        LOG: 'logs/setup.log',
      });
      process.exit(4);
      return;
    }

    fs.writeFileSync(configFile, JSON.stringify(parsed, null, 2) + '\n');
    allowedRoots = Array.isArray(parsed.allowedRoots) ? parsed.allowedRoots.length : 0;
    nonMainReadOnly = parsed.nonMainReadOnly === false ? 'false' : 'true';
  }

  log.info('Allowlist configured', { configFile, allowedRoots, nonMainReadOnly });

  emitStatus('CONFIGURE_MOUNTS', {
    PATH: configFile,
    ALLOWED_ROOTS: allowedRoots,
    NON_MAIN_READ_ONLY: nonMainReadOnly,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
