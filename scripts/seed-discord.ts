/**
 * Seed the v2 central DB with a Discord agent group + messaging group.
 *
 * Usage: pnpm exec tsx scripts/seed-discord.ts
 */
import { CENTRAL_DB_PATH } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup, getAgentGroup } from '../src/db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroup } from '../src/db/messaging-groups.js';

const db = await initDb(CENTRAL_DB_PATH);
await runMigrations(db);

const AGENT_GROUP_ID = 'ag-main';
const MESSAGING_GROUP_ID = 'mg-discord';
const CHANNEL_ID = 'discord:1470188214710046894:1491569326447132673';

// Agent group
if (!(await getAgentGroup(AGENT_GROUP_ID))) {
  await createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Main',
    folder: 'main',
    agent_provider: 'claude',
    created_at: new Date().toISOString(),
  });
  console.log('Created agent group:', AGENT_GROUP_ID);
} else {
  console.log('Agent group already exists:', AGENT_GROUP_ID);
}

// Messaging group
if (!(await getMessagingGroup(MESSAGING_GROUP_ID))) {
  await createMessagingGroup({
    id: MESSAGING_GROUP_ID,
    channel_type: 'discord',
    platform_id: CHANNEL_ID,
    name: 'Discord Test',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
  console.log('Created messaging group:', MESSAGING_GROUP_ID);
} else {
  console.log('Messaging group already exists:', MESSAGING_GROUP_ID);
}

// Link
try {
  await createMessagingGroupAgent({
    id: 'mga-discord',
    messaging_group_id: MESSAGING_GROUP_ID,
    agent_group_id: AGENT_GROUP_ID,
    // Discord group channel → mention-sticky default. Mention once, stay
    // subscribed to the thread. Admins can tune via /manage-channels.
    // Kept manually in sync with DISCORD_DEFAULTS.group on the channels
    // branch (the adapter is skill-installed, so the declaration can't be
    // imported here) — re-check this hardcode if that declaration changes.
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  console.log('Created messaging_group_agent link');
} catch (err: any) {
  if (err.message?.includes('UNIQUE')) {
    console.log('Messaging group agent link already exists');
  } else {
    throw err;
  }
}

console.log('Done! Run: pnpm run build && node dist/index.js');
