/**
 * End-to-end test of the per-group model endpoint (`container_configs.base_url`),
 * with a local stand-in for the endpoint so the run needs no model daemon.
 *
 * mock adapter → routeInbound → inbound.db → a REAL agent container →
 * ANTHROPIC_BASE_URL → the local Anthropic-shape stub → messages_out →
 * delivery → adapter.deliver().
 *
 * Nothing about the path under test is faked: the group is configured through
 * the same `ncl groups config update --base-url/--model` handler an operator
 * runs, the spec is composed by the real container-runner, and a real Docker
 * container makes the request. Only two things are stand-ins — the model
 * endpoint (the stub, so the run needs no daemon and no GPU) and the
 * credential gateway (the harness no-op, so it needs no vault).
 *
 * A PASS means: the container reached the endpoint the group's base_url names,
 * asked for the model the group's config names, and the reply came back out
 * through normal delivery. A real Ollama differs from the stub only in what it
 * puts in the text.
 *
 * Usage, from the install root:
 *   pnpm exec tsx scripts/test-v2-endpoint-e2e.ts
 *
 * Needs: this checkout's agent image (`./container/build.sh`) and Docker.
 * Env: STUB_PORT (default 21747), TIMEOUT_MS (default 240000).
 */
// Fills the host composition slots (mailbox) and registers the offline
// gateway. Must come first: everything below resolves a session.
import './harness-bootstrap.js';

import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

// Selected before any spawn path reads it: no vault in a verification run.
process.env.NANOCLAW_GATEWAY_PROVIDER ??= 'harness-noop';

const PORT = Number(process.env.STUB_PORT || 21747);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 240_000);
const MARKER = 'ENDPOINT-OVERRIDE-VERIFIED';
const GROUP_ID = 'ag-endpoint-verify';
const FOLDER = 'endpoint-verify';
const MODEL = 'stub-model:latest';
const DEST = 'verifychan';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const STUB = path.join(HERE, 'anthropic-endpoint-stub.mjs');

const TEST_DIR = '/tmp/nanoclaw-endpoint-verify';
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

import { INSTALL_SLUG } from '../src/config.js';
import { getChannelAdapter, initChannelAdapters, registerChannelAdapter } from '../src/channels/channel-registry.js';
import type { ChannelAdapter, OutboundMessage } from '../src/channels/adapter.js';
import { lookup } from '../src/cli/registry.js';
import '../src/cli/resources/index.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { ensureContainerConfig } from '../src/db/container-configs.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { findSession } from '../src/db/sessions.js';
import { setDeliveryAdapter, startActiveDeliveryPoll, stopDeliveryPolls } from '../src/delivery.js';
import { GROUP_FOLDER_LABEL, LABELS } from '../src/drivers/types.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { outboundDbPath } from '../src/mailbox/sqlite/paths.js';
import { createDestination } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { routeInbound } from '../src/router.js';

// The canned turn the stub answers with: an addressed message block, which is
// what the agent-runner turns into a delivered reply.
const REPLY = `<message to="${DEST}">${MARKER}</message>`;

const stub = spawn('node', [STUB, String(PORT), REPLY], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, STUB_MODEL: MODEL },
});

function cleanup(): void {
  stopDeliveryPolls();
  stub.kill('SIGTERM');
  try {
    const names = execSync(
      `docker ps -a --filter label=${LABELS.install}=${INSTALL_SLUG} ` +
        `--filter label=${GROUP_FOLDER_LABEL}=${FOLDER} --format "{{.Names}}"`,
    )
      .toString()
      .trim();
    for (const name of names.split('\n').filter(Boolean)) execSync(`docker rm -f ${name}`, { stdio: 'ignore' });
  } catch {
    /* nothing to clean up */
  }
}

await runMigrations(await initDb(path.join(TEST_DIR, 'v2.db')));

// Fresh session state each run; the group id is stable.
fs.rmSync(path.resolve(process.cwd(), 'data', 'v2-sessions', GROUP_ID), { recursive: true, force: true });

const now = new Date().toISOString();
const group = { id: GROUP_ID, name: 'Endpoint Verify', folder: FOLDER, agent_provider: 'claude', created_at: now };
await createAgentGroup(group);
await initGroupFilesystem(group, {
  instructions: `You are a verification probe. Reply to every message with one <message to="${DEST}"> block.`,
  provider: 'claude',
});
await ensureContainerConfig(GROUP_ID, 'claude');

// The operator-facing configuration, through the real command handler.
const configured = await lookup('groups-config-update')!.handler(
  { id: GROUP_ID, 'base-url': `http://host.docker.internal:${PORT}`, model: MODEL },
  { caller: 'host' },
);
console.log(`configured: ${JSON.stringify(configured)}`);

await createMessagingGroup({
  id: 'mg-endpoint-verify',
  channel_type: 'mock',
  platform_id: 'mock-endpoint-verify',
  name: 'Verify Channel',
  is_group: 0,
  unknown_sender_policy: 'public',
  created_at: now,
});
await createMessagingGroupAgent({
  id: 'mga-endpoint-verify',
  messaging_group_id: 'mg-endpoint-verify',
  agent_group_id: GROUP_ID,
  engage_mode: 'pattern',
  engage_pattern: '.',
  sender_scope: 'all',
  ignored_message_policy: 'drop',
  session_mode: 'shared',
  priority: 0,
  created_at: now,
});
await createDestination({
  agent_group_id: GROUP_ID,
  local_name: DEST,
  target_type: 'channel',
  target_id: 'mg-endpoint-verify',
  created_at: now,
});

const delivered: OutboundMessage[] = [];
const mockAdapter: ChannelAdapter = {
  name: 'mock',
  channelType: 'mock',
  async setup() {},
  async deliver(_platformId, _threadId, message) {
    delivered.push(message);
    const content = message.content as Record<string, unknown>;
    console.log(`  ✓ delivered: ${String(content.text ?? '').slice(0, 200)}`);
  },
  async setTyping() {},
  async teardown() {},
  isConnected() {
    return true;
  },
};
registerChannelAdapter('mock', { factory: () => mockAdapter });
await initChannelAdapters((adapter) => ({
  conversations: [
    {
      platformId: 'mock-endpoint-verify',
      agentGroupId: GROUP_ID,
      engageMode: 'pattern',
      engagePattern: '.',
      sessionMode: 'shared',
    },
  ],
  onInbound(platformId, threadId, message) {
    void routeInbound({
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
setDeliveryAdapter({
  async deliver(channelType, platformId, threadId, kind, content) {
    await getChannelAdapter(channelType)?.deliver(platformId, threadId, { kind, content: JSON.parse(content) });
  },
});
startActiveDeliveryPoll();

await routeInbound({
  channelType: 'mock',
  platformId: 'mock-endpoint-verify',
  threadId: null,
  message: {
    id: `msg-endpoint-verify-${Date.now()}`,
    kind: 'chat',
    content: JSON.stringify({ sender: 'Operator', text: 'ping' }),
    timestamp: new Date().toISOString(),
  },
});

const session = await findSession('mg-endpoint-verify', null);
console.log(`session=${session?.id} container=${session?.container_status}`);

const start = Date.now();
let hit = false;
while (Date.now() - start < TIMEOUT_MS) {
  if (delivered.some((m) => JSON.stringify(m.content).includes(MARKER))) {
    hit = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}

if (session) {
  try {
    const db = new Database(outboundDbPath(GROUP_ID, session.id), { readonly: true });
    const rows = db.prepare('SELECT id, kind, content FROM messages_out').all() as Array<Record<string, unknown>>;
    console.log(`messages_out: ${rows.length} row(s)`);
    for (const row of rows) console.log(`   [${row.id}] ${row.kind} ${String(row.content).slice(0, 300)}`);
    db.close();
  } catch (err) {
    console.log(`(outbound.db unreadable: ${String(err)})`);
  }
}

console.log(hit ? `\nRESULT: PASS — ${MARKER} arrived through delivery` : '\nRESULT: FAIL — marker never arrived');
cleanup();
process.exit(hit ? 0 : 1);
