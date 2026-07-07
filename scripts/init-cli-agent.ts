/**
 * Initialize the scratch CLI agent used during `/new-setup`.
 *
 * Creates the synthetic `cli:local` user, grants owner role if no owner
 * exists yet, builds an agent group with a minimal CLAUDE.md, and wires it
 * to the CLI messaging group so `pnpm run chat` works immediately.
 *
 * No welcome is staged — the operator's first `pnpm run chat` is the
 * natural wake, and the agent introduces itself on first contact per its
 * CLAUDE.md.
 *
 * Runs alongside the service (WAL-mode sqlite) — does NOT initialize
 * channel adapters, so there's no Gateway conflict.
 *
 * Usage:
 *   pnpm exec tsx scripts/init-cli-agent.ts \
 *     --display-name "Gavriel" \
 *     [--agent-name "Andy"]
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { updateContainerConfigScalars } from '../src/db/container-configs.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { normalizeName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

const CLI_CHANNEL = 'cli';
const CLI_PLATFORM_ID = 'local';
const CLI_SYNTHETIC_USER_ID = `${CLI_CHANNEL}:${CLI_PLATFORM_ID}`;

interface Args {
  displayName: string;
  agentName: string;
  folder?: string;
}

function parseArgs(argv: string[]): Args {
  let displayName: string | undefined;
  let agentName: string | undefined;
  let folder: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--display-name') {
      displayName = val;
      i++;
    } else if (key === '--agent-name') {
      agentName = val;
      i++;
    } else if (key === '--folder') {
      folder = val;
      i++;
    }
  }

  if (!displayName) {
    console.error('Missing required arg: --display-name');
    console.error('See scripts/init-cli-agent.ts header for usage.');
    process.exit(2);
  }

  return {
    displayName,
    agentName: agentName?.trim() || displayName,
    folder,
  };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();

  // 1. Synthetic CLI user + owner grant if none exists.
  upsertUser({
    id: CLI_SYNTHETIC_USER_ID,
    kind: CLI_CHANNEL,
    display_name: args.displayName,
    created_at: now,
  });

  // Owner grant deferred to init-first-agent when the real channel user is
  // wired — cli:local is a scratch identity, not the operator.
  const promotedToOwner = false;

  // 2. Agent group + filesystem.
  const folder = args.folder || `cli-with-${normalizeName(args.displayName)}`;
  const pickedProvider = process.env.NANOCLAW_PICKED_PROVIDER?.trim().toLowerCase();
  let ag: AgentGroup | undefined = getAgentGroupByFolder(folder);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: args.agentName,
      folder,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(folder)!;
    console.log(`Created agent group: ${ag.id} (${folder})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${folder})`);
  }
  initGroupFilesystem(ag, {
    instructions:
      `# ${args.agentName}\n\n` +
      `You are ${args.agentName}, a personal NanoClaw agent for ${args.displayName}. ` +
      'When the user first reaches out, introduce yourself briefly and invite them to chat. Keep replies concise.',
  });
  // Runtime provider lives on the config row, not the deprecated agent_provider.
  if (pickedProvider && pickedProvider !== 'claude') {
    updateContainerConfigScalars(ag.id, { provider: pickedProvider });
  }

  // 3. CLI messaging group + wiring.
  let cliMg: MessagingGroup | undefined = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
  if (!cliMg) {
    cliMg = {
      id: generateId('mg'),
      channel_type: CLI_CHANNEL,
      platform_id: CLI_PLATFORM_ID,
      name: 'Local CLI',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(cliMg);
    console.log(`Created CLI messaging group: ${cliMg.id}`);
  }

  const existing = getMessagingGroupAgentByPair(cliMg.id, ag.id);
  if (!existing) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: cliMg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired cli: ${cliMg.id} -> ${ag.id}`);
  } else {
    console.log(`Wiring already exists: ${existing.id}`);
  }

  console.log('');
  console.log('Init complete.');
  console.log(
    `  owner:   ${CLI_SYNTHETIC_USER_ID}${promotedToOwner ? ' (promoted on first owner)' : ''}`,
  );
  console.log(`  agent:   ${ag.name} [${ag.id}] @ groups/${folder}`);
  console.log(`  channel: cli/${CLI_PLATFORM_ID}`);
  console.log('');
  console.log('Run `pnpm run chat hi` to talk to your agent.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
