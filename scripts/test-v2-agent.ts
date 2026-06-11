/**
 * Quick integration test: create a session DB, insert a message,
 * run the v2 poll loop with the Claude provider, verify output.
 *
 * Usage: pnpm exec tsx scripts/test-v2-agent.ts
 */
import Database from 'better-sqlite3';
import fs from 'fs';

const TEST_DIR = '/tmp/nanoclaw-v2-test';
const DB_PATH = `${TEST_DIR}/session.db`;

// Clean up
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

// Create session DB
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE messages_in (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
    status TEXT DEFAULT 'pending', status_changed TEXT, process_after TEXT,
    recurrence TEXT, tries INTEGER DEFAULT 0, platform_id TEXT,
    channel_type TEXT, thread_id TEXT, content TEXT NOT NULL
  );
  CREATE TABLE messages_out (
    id TEXT PRIMARY KEY, in_reply_to TEXT, timestamp TEXT NOT NULL,
    delivered INTEGER DEFAULT 0, deliver_after TEXT, recurrence TEXT,
    kind TEXT NOT NULL, platform_id TEXT, channel_type TEXT,
    thread_id TEXT, content TEXT NOT NULL
  );
`);

// Insert test message
db.prepare(`INSERT INTO messages_in (id, kind, timestamp, status, content) VALUES (?, 'chat', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending', ?)`).run(
  'test-1',
  JSON.stringify({ sender: 'Gavriel', text: 'Say "Hello from v2!" and nothing else. Do not use any tools.' }),
);
console.log('✓ Session DB created with test message');
db.close();

// Set env and run the poll loop
process.env.SESSION_DB_PATH = DB_PATH;
process.env.AGENT_PROVIDER = 'claude';

const { getSessionDb, closeSessionDb } = await import('../container/agent-runner/src/db/connection.js');
const { getUndeliveredMessages } = await import('../container/agent-runner/src/db/messages-out.js');
const { getPendingMessages } = await import('../container/agent-runner/src/db/messages-in.js');
const { createProvider } = await import('../container/agent-runner/src/providers/factory.js');
const { runPollLoop } = await import('../container/agent-runner/src/poll-loop.js');

const provider = createProvider('claude');

console.log('✓ Claude provider created');
console.log('⏳ Starting poll loop (will timeout after 60s)...');

// Run with timeout
const timeout = setTimeout(() => {
  console.log('\n✗ Timed out after 60s');
  printResults();
  process.exit(1);
}, 60_000);

// Poll for results in parallel
const resultChecker = setInterval(() => {
  try {
    const out = getUndeliveredMessages();
    if (out.length > 0) {
      clearTimeout(timeout);
      clearInterval(resultChecker);
      console.log('\n✓ Got response!');
      printResults();
      process.exit(0);
    }
  } catch {
    // DB might be locked, retry
  }
}, 500);

function printResults() {
  const db2 = new Database(DB_PATH, { readonly: true });
  const inRows = db2.prepare('SELECT * FROM messages_in').all() as Array<Record<string, unknown>>;
  const outRows = db2.prepare('SELECT * FROM messages_out').all() as Array<Record<string, unknown>>;
  console.log('\n--- messages_in ---');
  for (const r of inRows) {
    console.log(`  [${r.id}] status=${r.status} kind=${r.kind} content=${r.content}`);
  }
  console.log('\n--- messages_out ---');
  for (const r of outRows) {
    console.log(`  [${r.id}] kind=${r.kind} content=${r.content}`);
  }
  db2.close();
}

// Start the poll loop (runs forever, we exit from the checker above)
try {
  await runPollLoop({
    provider,
    cwd: TEST_DIR,
    mcpServers: {},
    env: { ...process.env },
  });
} catch (err) {
  // Expected — we force exit
}
