/**
 * Container-side integration test: seed a session mailbox, run the REAL poll
 * loop against a provider, verify a message comes out the other end.
 *
 * Runs under BUN, not tsx. Everything under container/agent-runner/ reaches
 * `bun:sqlite`, which Node cannot load, so:
 *
 *   bun scripts/test-v2-agent.ts                        # mock provider, offline
 *   AGENT_PROVIDER=claude bun scripts/test-v2-agent.ts  # real Claude
 *
 * Exits 0 when an outbound message lands, 1 on timeout. The `claude` path needs
 * both credentials and the `claude-code` CLI on PATH — that binary is installed
 * into the agent image (container/cli-tools.json), not onto the host, so on a
 * bare host it stops at "Claude Code native binary not found". Use the mock
 * here to exercise the loop, and scripts/test-v2-host.ts or
 * scripts/test-v2-channel-e2e.ts to exercise a real provider inside a container.
 *
 * The previous version could not run at all: it was invoked with `pnpm exec
 * tsx`, wrote a single `session.db` with a hand-rolled schema, and pointed the
 * runner at it with `SESSION_DB_PATH` — a variable nothing has read since the
 * two-DB split. It also called `runPollLoop` with an `mcpServers`/`env` config
 * shape the loop no longer accepts, and never registered the mailbox
 * composition slot, so it died on `No agent mailbox registered`.
 *
 * The session state here is the in-memory pair from `initTestSessionDb()`,
 * which is what the container's own test suite uses — the real connection
 * layer hard-codes /workspace/inbound.db and /workspace/outbound.db, so a
 * host-side harness cannot point it anywhere else.
 */

// Mailbox composition slot. Must precede anything that touches the mailbox.
import '../container/agent-runner/src/modules/index.js';
// Provider barrel (registers `claude`), plus the mock, which the barrel
// deliberately does not carry.
import '../container/agent-runner/src/providers/index.js';
import '../container/agent-runner/src/providers/mock.js';

import { loadConfig } from '../container/agent-runner/src/config.js';
import {
  closeSessionDb,
  getInboundDb,
  getOutboundDb,
  initTestSessionDb,
} from '../container/agent-runner/src/mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../container/agent-runner/src/db/messages-out.js';
import { getAgentMailbox } from '../container/agent-runner/src/mailbox/index.js';
import { runPollLoop } from '../container/agent-runner/src/poll-loop.js';
import { MEMORY_SESSION_HOOK } from '../container/agent-runner/src/memory/session-hook.js';
import { createProvider } from '../container/agent-runner/src/providers/factory.js';
import { MockProvider } from '../container/agent-runner/src/providers/mock.js';
import type { AgentProvider } from '../container/agent-runner/src/providers/types.js';

const DEST = 'test-chat';
const TIMEOUT_MS = 60_000;
const providerName = process.env.AGENT_PROVIDER || 'mock';

// container.json is absent on the host, so this falls back to defaults and
// says so on stderr. It has to run: getConfig() throws until it does.
loadConfig();

initTestSessionDb();

// A destination the agent can address. The poll loop only emits an outbound
// message for a `<message to="name">` block whose name resolves here, so
// without this row nothing is ever written to messages_out. A 'channel'
// destination carries channel_type + platform_id and NO agent_group_id — the
// mailbox model rejects the mixed shape ('channel routing fields').
getInboundDb()
  .prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES (?, ?, 'channel', 'test', 'test-platform-1', NULL)`,
  )
  .run(DEST, 'Test Chat');

getInboundDb()
  .prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, on_wake, platform_id, channel_type, content)
     VALUES (?, 2, 'chat', ?, 'pending', 1, 0, 'test-platform-1', 'test', ?)`,
  )
  .run(
    'test-1',
    new Date().toISOString(),
    JSON.stringify({
      sender: 'Gavriel',
      text: `Reply with exactly <message to="${DEST}">Hello from v2!</message> and nothing else. Do not use any tools.`,
    }),
  );

console.log('✓ Session mailbox seeded with 1 pending message');

await getAgentMailbox().start(null);

// The stock MockProvider echoes the prompt unwrapped, and unwrapped text is
// scratchpad the loop drops on purpose — so the mock path supplies the
// `<message>` envelope the formatter requires. Any other provider name is
// resolved through the real registry.
const provider: AgentProvider =
  providerName === 'mock'
    ? new MockProvider({}, () => `<message to="${DEST}">Hello from v2!</message>`)
    : createProvider(providerName);

// Same wiring the real runner does at startup (container/agent-runner/
// src/index.ts): the Claude provider refuses to query until the memory
// session hook is registered. The mock's implementation is a no-op.
provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

console.log(`✓ Provider: ${providerName}`);
console.log(`⏳ Running the poll loop (timeout ${TIMEOUT_MS / 1000}s)...`);

// The loop runs until aborted; the watcher below stops it as soon as an
// outbound message lands. Without a signal an abandoned loop keeps polling.
const stop = new AbortController();

function printResults(): void {
  const inRows = getInboundDb().prepare('SELECT * FROM messages_in').all() as Array<Record<string, unknown>>;
  const outRows = getOutboundDb().prepare('SELECT * FROM messages_out').all() as Array<Record<string, unknown>>;
  console.log('\n--- messages_in (inbound) ---');
  for (const r of inRows) {
    console.log(`  [${r.id}] status=${r.status} kind=${r.kind}`);
  }
  console.log('\n--- messages_out (outbound) ---');
  for (const r of outRows) {
    console.log(`  [${r.id}] kind=${r.kind} content=${r.content}`);
  }
  // messages_in.status stays 'pending' here on purpose: it is the HOST's
  // column. The container records its own progress in processing_ack, in
  // outbound.db — that is the row to read to see the loop finish a message.
  const ackRows = getOutboundDb().prepare('SELECT * FROM processing_ack').all() as Array<Record<string, unknown>>;
  console.log('\n--- processing_ack (outbound) ---');
  for (const r of ackRows) {
    console.log(`  [${r.message_id}] status=${r.status} changed=${r.status_changed}`);
  }
}

const deadline = Date.now() + TIMEOUT_MS;
const watcher = new Promise<boolean>((resolve) => {
  const timer = setInterval(() => {
    let delivered = 0;
    try {
      delivered = getUndeliveredMessages().length;
    } catch {
      // The loop may hold a write lock; retry on the next tick.
    }
    if (delivered > 0) {
      clearInterval(timer);
      resolve(true);
    } else if (Date.now() > deadline) {
      clearInterval(timer);
      resolve(false);
    }
  }, 500);
});

const loop = runPollLoop({ provider, providerName, cwd: '/tmp', signal: stop.signal }).catch((err) => {
  console.error('poll loop threw:', err);
});

const ok = await watcher;
stop.abort();
await loop;

if (ok) console.log('\n✓ Got a response through the real poll loop');
else console.log(`\n✗ No outbound message within ${TIMEOUT_MS / 1000}s`);

printResults();
closeSessionDb();
process.exit(ok ? 0 : 1);
