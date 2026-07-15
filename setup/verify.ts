/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { log } from '../src/log.js';
import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import {
  getPlatform,
  getServiceManager,
  hasSystemd,
  isRoot,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const homeDir = os.homedir();

  log.info('Starting verification');

  // 1. Check service status + detect checkout mismatch.
  //
  // Why the mismatch matters: the host reads `<projectRoot>/data/v2.db` and
  // binds `<DATA_DIR>/cli.sock` relative to the project root it was started
  // from. If the running service is from a sibling checkout (common for
  // developers with multiple clones), nothing in this checkout is actually
  // wired up. Surface the mismatch directly so the user knows to point the
  // service at the right folder.
  let service:
    | 'not_found'
    | 'stopped'
    | 'running'
    | 'running_other_checkout' = 'not_found';
  let runningFromPath: string | null = null;
  const mgr = getServiceManager();

  const launchdLabel = getLaunchdLabel(projectRoot);
  const systemdUnit = getSystemdUnit(projectRoot);

  if (mgr === 'launchd') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      const line = output.split('\n').find((l) => l.includes(launchdLabel));
      if (line) {
        const pidField = line.trim().split(/\s+/)[0];
        if (pidField !== '-' && pidField) {
          service = 'running';
          const pid = Number(pidField);
          if (Number.isInteger(pid) && pid > 0) {
            runningFromPath = resolveBinaryScript(pid);
          }
        } else {
          service = 'stopped';
        }
      }
    } catch {
      // launchctl not available
    }
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} is-active ${systemdUnit}`, { stdio: 'ignore' });
      service = 'running';
      try {
        const pidStr = execSync(
          `${prefix} show ${systemdUnit} -p MainPID --value`,
          { encoding: 'utf-8' },
        ).trim();
        const pid = Number(pidStr);
        if (Number.isInteger(pid) && pid > 0) {
          runningFromPath = resolveBinaryScript(pid);
        }
      } catch {
        // couldn't read MainPID; leave runningFromPath null
      }
    } catch {
      try {
        const output = execSync(`${prefix} list-unit-files`, {
          encoding: 'utf-8',
        });
        if (output.includes(systemdUnit)) {
          service = 'stopped';
        }
      } catch {
        // systemctl not available
      }
    }
  } else {
    // Check for nohup PID file
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const raw = fs.readFileSync(pidFile, 'utf-8').trim();
        const pid = Number(raw);
        if (raw && Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          service = 'running';
          runningFromPath = resolveBinaryScript(pid);
        }
      } catch {
        service = 'stopped';
      }
    }
  }

  if (
    service === 'running' &&
    runningFromPath &&
    !isPathInside(runningFromPath, projectRoot)
  ) {
    service = 'running_other_checkout';
  }

  log.info('Service status', { service, runningFromPath });

  // 2. Check container runtime
  let containerRuntime = 'none';
  try {
    execSync('docker info', { stdio: 'ignore' });
    containerRuntime = 'docker';
  } catch {
    // Docker not running
  }

  // 3. Check credentials
  let credentials = 'missing';
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ONECLI_URL)=/m.test(envContent)) {
      credentials = 'configured';
    }
  }

  // 4. Check channel auth (detect configured channels by credentials)
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DISCORD_BOT_TOKEN',
    'GITHUB_TOKEN',
    'LINEAR_API_KEY',
    'GCHAT_CREDENTIALS',
    'TEAMS_APP_ID',
    'TEAMS_APP_PASSWORD',
    'WEBEX_BOT_TOKEN',
    'MATRIX_ACCESS_TOKEN',
    'RESEND_API_KEY',
    'WHATSAPP_ACCESS_TOKEN',
    'IMESSAGE_ENABLED',
  ]);

  const has = (key: string) => !!(process.env[key] || envVars[key]);
  const channelAuth: Record<string, string> = {};

  // WhatsApp Baileys: check for auth credentials on disk
  const authDir = path.join(projectRoot, 'store', 'auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    channelAuth.whatsapp = 'authenticated';
  }

  // Token-based channels
  if (has('DISCORD_BOT_TOKEN')) channelAuth.discord = 'configured';
  if (has('TELEGRAM_BOT_TOKEN')) channelAuth.telegram = 'configured';
  if (has('SLACK_BOT_TOKEN') && has('SLACK_APP_TOKEN')) channelAuth.slack = 'configured';
  if (has('GITHUB_TOKEN')) channelAuth.github = 'configured';
  if (has('LINEAR_API_KEY')) channelAuth.linear = 'configured';
  if (has('GCHAT_CREDENTIALS')) channelAuth.gchat = 'configured';
  if (has('TEAMS_APP_ID') && has('TEAMS_APP_PASSWORD')) channelAuth.teams = 'configured';
  if (has('WEBEX_BOT_TOKEN')) channelAuth.webex = 'configured';
  if (has('MATRIX_ACCESS_TOKEN')) channelAuth.matrix = 'configured';
  if (has('RESEND_API_KEY')) channelAuth.resend = 'configured';
  if (has('WHATSAPP_ACCESS_TOKEN')) channelAuth['whatsapp-cloud'] = 'configured';
  if (has('IMESSAGE_ENABLED')) channelAuth.imessage = 'configured';

  const configuredChannels = Object.keys(channelAuth);

  // 5. Check registered groups in v2 central DB (agent_groups + messaging_group_agents)
  let registeredGroups = 0;
  const dbPath = path.join(DATA_DIR, 'v2.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      // Count agent groups that have at least one messaging group wired
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT ag.id) as count FROM agent_groups ag
           JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id`,
        )
        .get() as { count: number };
      registeredGroups = row.count;
      db.close();
    } catch {
      // Table might not exist (DB not migrated yet)
    }
  }

  // 6. Check mount allowlist
  let mountAllowlist = 'missing';
  if (
    fs.existsSync(
      path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json'),
    )
  ) {
    mountAllowlist = 'configured';
  }

  // Deferred-wire channels can't have a group yet: their platform id only
  // exists after the first inbound DM (see add-teams' "Finish wiring"), so
  // configured-but-unwired is pending operator action, not a broken install.
  // Only claim pending when EVERY configured channel is defer-wire — a
  // wire-during-setup channel (slack, telegram, …) with zero groups is a
  // genuine failure this must not mask.
  const wiringPending =
    registeredGroups === 0 &&
    configuredChannels.length > 0 &&
    configuredChannels.every((c) => DEFER_WIRE_CHANNELS.has(c));

  // Determine overall status. The cli-agent step earlier in setup already
  // proved the agent round-trip works; verify is a static health check.
  const status = determineVerifyStatus({
    service,
    credentials,
    registeredGroups,
    wiringPending,
  });

  log.info('Verification complete', { status, channelAuth, wiringPending });

  emitStatus('VERIFY', {
    SERVICE: service,
    CONTAINER_RUNTIME: containerRuntime,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    MOUNT_ALLOWLIST: mountAllowlist,
    ...(wiringPending ? { WIRING: 'pending_first_dm' } : {}),
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}

/**
 * Channels whose wiring only completes after the first inbound message —
 * the platform id doesn't exist until the bot is DM'd, so setup ends with
 * the channel configured but no group wired. Kept in lockstep with the
 * wireIfResolved call site in setup/auto.ts (its unresolved drop-through
 * leaves the channel configured but unwired).
 */
export const DEFER_WIRE_CHANNELS = new Set(['teams']);

export function determineVerifyStatus(input: {
  service: 'not_found' | 'stopped' | 'running' | 'running_other_checkout';
  credentials: string;
  registeredGroups: number;
  /** Zero groups but every configured channel defers wiring to the first DM. */
  wiringPending?: boolean;
}): 'success' | 'failed' {
  return input.service === 'running' &&
    input.credentials !== 'missing' &&
    (input.registeredGroups > 0 || input.wiringPending === true)
    ? 'success'
    : 'failed';
}

/**
 * Given a PID, resolve the script path the process is executing (i.e. the
 * first `.js` / `.ts` / `.mjs` arg after `node`). Returns null on any
 * error — callers should treat null as "couldn't tell" and skip the
 * mismatch check rather than flag a false positive.
 */
function resolveBinaryScript(pid: number): string | null {
  try {
    // BSD ps (macOS) and util-linux both honour `-o command=` (full argv,
    // no header). Node argv: "node /path/to/dist/index.js ...".
    const out = execSync(`ps -p ${pid} -o command=`, {
      encoding: 'utf-8',
    }).trim();
    const tokens = out.split(/\s+/);
    const script = tokens.find((t) => /\.(js|mjs|cjs|ts)$/.test(t));
    return script ?? null;
  } catch {
    return null;
  }
}

function isPathInside(candidate: string, parent: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
