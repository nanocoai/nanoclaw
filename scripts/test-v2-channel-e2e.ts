/**
 * End-to-end test of v2 channel adapter pipeline:
 *
 * Mock adapter → onInbound → router → session DB → Docker container →
 * agent-runner → Claude → messages_out → delivery → mock adapter.deliver()
 *
 * Usage: pnpm exec tsx scripts/test-v2-channel-e2e.ts
 *
 * Needs the agent image for this checkout (`./container/build.sh`) and, for a
 * real answer, Claude credentials via the OneCLI vault. To exercise the whole
 * pipeline up to and including the container spawn without a vault, select the
 * harness's offline gateway:
 *
 *   NANOCLAW_GATEWAY_PROVIDER=harness-noop pnpm exec tsx scripts/test-v2-channel-e2e.ts
 */
// Fills the host composition slots (mailbox today). Must come first: every
// path below resolves a session, and an unregistered mailbox throws.
import './harness-bootstrap.js';

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TEST_DIR = '/tmp/nanoclaw-v2-channel-e2e';
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

// --- Step 1: Init central DB ---
console.log('\n=== Step 1: Init central DB ===');

import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../src/db/messaging-groups.js';
import { GROUP_FOLDER_LABEL, LABELS } from '../src/drivers/types.js';
import { INSTALL_SLUG } from '../src/config.js';
import type { AgentGroup } from '../src/types.js';

const centralDb = await initDb(path.join(TEST_DIR, 'v2.db'));
await runMigrations(centralDb);

// The agent group's filesystem AND its container_configs row are both
// scaffolded by initGroupFilesystem. Hand-rolling the folder is not enough:
// spawn calls materializeContainerJson, which throws
// `Container config not found for agent group: ...` when the row is missing.
const group: AgentGroup = {
  id: 'ag-chan',
  name: 'Channel E2E Agent',
  folder: 'test-channel-e2e',
  agent_provider: 'claude',
  created_at: new Date().toISOString(),
};
await createAgentGroup(group);
await initGroupFilesystem(group, {
  instructions: 'You are a test agent. Be brief.',
  provider: 'claude',
});

const testGroupDir = path.resolve(process.cwd(), 'groups', group.folder);

await createMessagingGroup({
  id: 'mg-chan',
  channel_type: 'mock',
  platform_id: 'mock-channel-1',
  name: 'Mock Channel',
  is_group: 0,
  unknown_sender_policy: 'public',
  created_at: new Date().toISOString(),
});

await createMessagingGroupAgent({
  id: 'mga-chan',
  messaging_group_id: 'mg-chan',
  agent_group_id: 'ag-chan',
  engage_mode: 'pattern',
  engage_pattern: '.',
  sender_scope: 'all',
  ignored_message_policy: 'drop',
  session_mode: 'shared',
  priority: 0,
  created_at: new Date().toISOString(),
});

console.log('✓ Central DB initialized');

// --- Step 2: Set up mock channel adapter + delivery ---
console.log('\n=== Step 2: Set up mock channel adapter & delivery ===');

import { routeInbound } from '../src/router.js';
import { setDeliveryAdapter, startActiveDeliveryPoll, stopDeliveryPolls } from '../src/delivery.js';
import { getChannelAdapter, registerChannelAdapter, initChannelAdapters } from '../src/channels/channel-registry.js';
import { findSession } from '../src/db/sessions.js';
import { inboundDbPath, outboundDbPath } from '../src/mailbox/sqlite/paths.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from '../src/channels/adapter.js';

// Track delivered messages
const deliveredMessages: Array<{ platformId: string; threadId: string | null; message: OutboundMessage }> = [];
let lastDeliveryTime = 0;
const startTime = Date.now();

// Create mock adapter
const mockAdapter: ChannelAdapter = {
  name: 'mock',
  channelType: 'mock',

  async setup(config: ChannelSetup) {
    console.log(`  ✓ Mock adapter setup with ${config.conversations.length} conversations`);
  },

  async deliver(platformId, threadId, message) {
    deliveredMessages.push({ platformId, threadId, message });
    lastDeliveryTime = Date.now();
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const content = message.content as Record<string, unknown>;
    const text = ((content.text as string) || '').slice(0, 120);
    console.log(`  ✓ [${elapsed}s] Delivered #${deliveredMessages.length}: ${text}...`);
  },

  async setTyping() {},
  async teardown() {},
  isConnected() {
    return true;
  },
};

// Register mock adapter
registerChannelAdapter('mock', { factory: () => mockAdapter });

// Init channel adapters — this calls setup() with conversation configs from central DB
await initChannelAdapters((adapter) => ({
  conversations: [
    {
      platformId: 'mock-channel-1',
      agentGroupId: 'ag-chan',
      engageMode: 'pattern',
      engagePattern: '.',
      sessionMode: 'shared',
    },
  ],
  onInbound(platformId, threadId, message) {
    routeInbound({
      channelType: adapter.channelType,
      platformId,
      threadId,
      message: {
        id: message.id,
        kind: message.kind,
        content: JSON.stringify(message.content),
        timestamp: message.timestamp,
      },
    }).catch((err) => console.error('Route error:', err));
  },
  onMetadata() {},
}));

// Set up delivery adapter bridge
setDeliveryAdapter({
  async deliver(channelType, platformId, threadId, kind, content) {
    const adapter = getChannelAdapter(channelType);
    if (!adapter) return;
    await adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content) });
  },
});

// Start delivery polling
startActiveDeliveryPoll();
console.log('✓ Mock adapter & delivery configured');

// --- Step 3: Simulate inbound message through adapter ---
console.log('\n=== Step 3: Simulate inbound message ===');

// Call routeInbound directly — exactly what the adapter's onInbound callback
// above does when a real platform message arrives.
await routeInbound({
  channelType: 'mock',
  platformId: 'mock-channel-1',
  threadId: null,
  message: {
    id: 'msg-chan-1',
    kind: 'chat',
    content: JSON.stringify({
      sender: 'Gavriel',
      text: 'Call the send_message tool 3 times: text="Update 1", text="Update 2", text="Update 3". Make each call separately. After all 3, say "Done".',
    }),
    timestamp: new Date().toISOString(),
  },
});

const session = await findSession('mg-chan', null);
if (!session) {
  console.log('✗ No session created!');
  cleanup();
  process.exit(1);
}
console.log(`✓ Session: ${session.id}`);
console.log(`✓ Container status: ${session.container_status}`);

import { execSync } from 'child_process';
const checkContainerLogs = () => {
  try {
    // Scope to THIS install and this group's folder — the label is
    // `nanoclaw-group-folder` carrying the full folder name, and a peer
    // install's containers must never be read (or reported) as ours.
    const containers = execSync(
      `docker ps -a --filter label=${LABELS.install}=${INSTALL_SLUG} ` +
        `--filter label=${GROUP_FOLDER_LABEL}=${group.folder} --format "{{.Names}}"`,
    )
      .toString()
      .trim();
    for (const name of containers.split('\n').filter(Boolean)) {
      console.log(`\nContainer logs (${name}):`);
      console.log(execSync(`docker logs ${name} 2>&1`).toString());
    }
  } catch {
    /* ignore */
  }
};

const inDbPath = inboundDbPath('ag-chan', session.id);
const outDbPath = outboundDbPath('ag-chan', session.id);
console.log(`✓ Inbound DB:  ${inDbPath}`);
console.log(`✓ Outbound DB: ${outDbPath}`);

// --- Step 4: Wait for delivery through mock adapter ---
console.log('\n=== Step 4: Waiting for delivery through mock adapter... ===');
const TIMEOUT_MS = 300_000;

// Wait for deliveries — resolve when no new ones for 30s after first delivery
await new Promise<void>((resolve) => {
  const poll = () => {
    if (lastDeliveryTime > 0 && Date.now() - lastDeliveryTime > 30_000) {
      resolve();
      return;
    }
    if (Date.now() - startTime > TIMEOUT_MS) {
      console.log(`\n✗ Timed out after ${TIMEOUT_MS / 1000}s`);
      // Check session DB directly
      try {
        // messages_out lives in outbound.db (the container is its sole
        // writer); reading it from inbound.db threw and the surrounding catch
        // swallowed the whole diagnostic.
        const db = new Database(outDbPath, { readonly: true });
        const out = db.prepare('SELECT * FROM messages_out').all();
        console.log(`  messages_out rows: ${out.length}`);
        if (out.length > 0) console.log('  (messages exist but delivery failed)');
        db.close();
      } catch (err) {
        console.log(`  (could not read outbound DB: ${err})`);
      }
      checkContainerLogs();
      cleanup();
      process.exit(1);
    }
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed > 0 && elapsed % 10 === 0) {
      process.stdout.write(`  ${elapsed}s...`);
    }
    setTimeout(poll, 1000);
  };
  poll();
});

// --- Step 5: Print results ---
console.log('\n\n=== Results ===');

console.log('\nSession DBs:');
try {
  const inDb = new Database(inDbPath, { readonly: true });
  const inRows = inDb.prepare('SELECT * FROM messages_in').all() as Array<Record<string, unknown>>;
  inDb.close();

  console.log(`  messages_in (inbound.db): ${inRows.length} row(s)`);
  for (const r of inRows) {
    console.log(`    [${r.id}] status=${r.status} kind=${r.kind}`);
  }
} catch (err) {
  console.log(`  (could not read inbound DB: ${err})`);
}

try {
  // Separate try/catch per file: the two DBs fail independently, and one
  // unreadable file must not hide the other's rows.
  const outDb = new Database(outDbPath, { readonly: true });
  const outRows = outDb.prepare('SELECT * FROM messages_out').all() as Array<Record<string, unknown>>;
  outDb.close();

  console.log(`  messages_out (outbound.db): ${outRows.length} row(s)`);
  for (const r of outRows) {
    const content = JSON.parse(r.content as string);
    console.log(`    [${r.id}] kind=${r.kind}`);
    console.log(`    → ${content.text}`);
  }
} catch (err) {
  console.log(`  (could not read outbound DB: ${err})`);
}

console.log('\nDelivered through mock adapter:');
for (const d of deliveredMessages) {
  const content = d.message.content as Record<string, unknown>;
  console.log(`  → [${d.platformId}] ${content.text}`);
}

console.log('\n✓ Full channel adapter pipeline verified!');

cleanup();
process.exit(0);

function cleanup() {
  stopDeliveryPolls();
  fs.rmSync(testGroupDir, { recursive: true, force: true });
}
