/**
 * Step: cli-agent — Create the scratch CLI agent for `/new-setup`.
 *
 * Thin wrapper around `scripts/init-cli-agent.ts`. Emits a status block so
 * /new-setup SKILL.md can parse the result without having to read the
 * script's plain stdout.
 *
 * Args:
 *   --display-name <name>   (required) operator's display name
 *   --agent-name   <name>   (optional) agent persona name, defaults to display-name
 *   --folder       <name>   (optional) explicit folder name, defaults to cli-with-<normalized-display-name>
 */
import { execFileSync } from 'child_process';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): {
  displayName: string;
  agentName?: string;
  folder?: string;
} {
  let displayName: string | undefined;
  let agentName: string | undefined;
  let folder: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    switch (key) {
      case '--display-name':
        displayName = val;
        i++;
        break;
      case '--agent-name':
        agentName = val;
        i++;
        break;
      case '--folder':
        folder = val;
        i++;
        break;
    }
  }

  if (!displayName) {
    emitStatus('CLI_AGENT', {
      STATUS: 'failed',
      ERROR: 'missing_display_name',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  return { displayName, agentName, folder };
}

export async function run(args: string[]): Promise<void> {
  const { displayName, agentName, folder } = parseArgs(args);

  const projectRoot = process.cwd();
  const script = path.join(projectRoot, 'scripts', 'init-cli-agent.ts');

  const scriptArgs = ['exec', 'tsx', script, '--display-name', displayName];
  if (agentName) scriptArgs.push('--agent-name', agentName);
  if (folder) scriptArgs.push('--folder', folder);

  log.info('Invoking init-cli-agent', { displayName, agentName });

  // Provider-agnostic: init-cli-agent creates a default group and emits its id.
  // Surface that id so the orchestrator can set the picked provider on it (via
  // ncl) before the ping — provider is a DB property, never a creation flag.
  let stdout = '';
  try {
    stdout = execFileSync('pnpm', scriptArgs, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    log.error('init-cli-agent failed', {
      status: e.status,
      stdout: e.stdout,
      stderr: e.stderr,
    });
    emitStatus('CLI_AGENT', {
      STATUS: 'failed',
      ERROR: 'init_script_failed',
      EXIT_CODE: e.status ?? -1,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const agentGroupId = stdout.match(/^AGENT_GROUP_ID:\s*(\S+)/m)?.[1];

  emitStatus('CLI_AGENT', {
    DISPLAY_NAME: displayName,
    AGENT_NAME: agentName || displayName,
    CHANNEL: 'cli/local',
    ...(agentGroupId ? { AGENT_GROUP_ID: agentGroupId } : {}),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
