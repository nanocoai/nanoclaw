/**
 * Finish (or retry) the Slack leg of an agent created via create_agent.
 *
 * The in-host slack-agent-flow wrapper points here when the Slack leg fails
 * partway: re-runs S1–S13 idempotently (provision reuses .env tokens, every
 * DB row is get-before-create, conversations.open is idempotent on Slack's
 * side, intro posts are gated on newly-created rows) EXCEPT the S5 hot-add —
 * a separate process cannot start an adapter inside the live host, so the
 * new instance comes online via a service restart instead (--restart runs it,
 * otherwise the command is printed).
 *
 * Runs alongside the service the way scripts/init-first-agent.ts does
 * (WAL-mode sqlite; no channel adapters are connected — the channels barrel
 * import is registration-only, so declared defaults resolve here).
 *
 * Usage:
 *   pnpm exec tsx scripts/slack-agent-flow-finish.ts \
 *     --group <newAgentGroupId> \
 *     --name <slug> \
 *     --source-group <sourceAgentGroupId> \
 *     [--origin-instance <key>] \   # default: slack
 *     [--room none] \               # original create used room:'none' — skip the shared room
 *     [--restart]
 *
 * Never prints token values — only key names and ids.
 */
import { execFileSync } from 'child_process';
import path from 'path';

// Registration-only barrel import: channel modules call
// registerChannelAdapter() at module scope (factories are NOT invoked, no
// adapter connects), so declared channel defaults resolve here without live
// adapters.
import '../src/channels/index.js';
import { SlackApiError } from '../src/channels/slack-lib.js';
import { DATA_DIR } from '../src/config.js';
import { getAgentGroup } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { finishSlackAgentFlow } from '../src/modules/slack-agent-flow/orchestrate.js';
import { SlackFlowError } from '../src/modules/slack-agent-flow/types.js';

interface Args {
  group: string;
  name: string;
  sourceGroup: string;
  originInstance: string;
  restart: boolean;
  allowGuests: boolean;
  room?: 'own' | 'none';
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  let restart = false;
  let allowGuests = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--group':
        out.group = val;
        i++;
        break;
      case '--name':
        out.name = val;
        i++;
        break;
      case '--source-group':
        out.sourceGroup = val;
        i++;
        break;
      case '--origin-instance':
        out.originInstance = val;
        i++;
        break;
      case '--room': {
        if (val !== 'own' && val !== 'none') {
          console.error(`--room must be 'own' or 'none', got "${val}"`);
          process.exit(2);
        }
        out.room = val;
        i++;
        break;
      }
      case '--restart':
        restart = true;
        break;
      case '--allow-guests':
        allowGuests = true;
        break;
      default:
        console.error(`Unknown flag: ${key}`);
        process.exit(2);
    }
  }
  const missing = (['group', 'name', 'sourceGroup'] as const).filter((k) => !out[k]);
  if (missing.length) {
    console.error(
      `Missing required args: ${missing.map((k) => `--${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`).join(', ')}`,
    );
    console.error('See scripts/slack-agent-flow-finish.ts header for usage.');
    process.exit(2);
  }
  return {
    group: out.group!,
    name: out.name!,
    sourceGroup: out.sourceGroup!,
    originInstance: out.originInstance ?? 'slack',
    restart,
    allowGuests,
    room: out.room,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();

  const db = await initDb(path.join(DATA_DIR, 'v2.db'));
  await runMigrations(db); // idempotent

  const newGroup = await getAgentGroup(args.group);
  if (!newGroup) throw new Error(`agent group ${args.group} not found (--group)`);
  if (!(await getAgentGroup(args.sourceGroup))) {
    throw new Error(`agent group ${args.sourceGroup} not found (--source-group)`);
  }

  const result = await finishSlackAgentFlow({
    slug: args.name,
    sourceGroupId: args.sourceGroup,
    newAgentGroupId: args.group,
    originInstanceKey: args.originInstance,
    rootDir: root,
    allowGuests: args.allowGuests,
    room: args.room,
    // A workspace install approval can hold this for minutes; say so rather
    // than letting the script look hung.
    onInstallPending: (text) => {
      console.log('');
      console.log(text);
      console.log('Waiting…');
    },
  });

  console.log('');
  console.log('Slack leg complete:');
  console.log(`  agent     ${newGroup.name} [${args.group}]`);
  console.log(
    `  instance  slack-${result.slug} (SLACK_INSTANCES + SLACK_*_TOKEN_${result.slug.toUpperCase().replace(/-/g, '_')})`,
  );
  console.log(`  bot       ${result.newBotUserId}`);
  console.log(`  DM        ${result.dmChannelId} (operator ${result.operatorUserId})`);
  console.log(
    result.roomChannelId
      ? `  room      ${result.roomChannelId} (SLACK_A2A_ROOMS)`
      : `  room      (skipped — room:'none')`,
  );
  console.log('');

  // S5 replacement: the new adapter instance connects on the next service
  // start — this process cannot hot-add into the live host.
  if (args.restart) {
    console.log('Restarting the service so the new instance connects…');
    execFileSync('bash', [path.join(root, 'setup', 'lib', 'restart.sh')], { cwd: root, stdio: 'inherit' });
  } else {
    console.log('Restart the service so the new instance connects: bash setup/lib/restart.sh');
  }
}

main().catch((err: unknown) => {
  if (err instanceof SlackFlowError || err instanceof SlackApiError) {
    console.error(`slack-agent-flow-finish failed at step '${err.step}': ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
