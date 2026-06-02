import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

interface Payload {
  agentId: string;
  fromAgentId: string;
  fromName: string;
  text: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function nextEvenSeq(db: Database.Database): number {
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  return maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);
}

function decodePayload(): Payload {
  const encoded = process.argv[2];
  if (!encoded) fail('Missing base64 payload');
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Payload;
    if (!parsed.agentId || !parsed.fromAgentId || !parsed.text) fail('Payload missing required fields');
    return parsed;
  } catch (err) {
    fail(`Invalid payload: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const payload = decodePayload();
const root = process.cwd();
const centralPath = path.join(root, 'data', 'v2.db');
const central = new Database(centralPath);

try {
  const session = central
    .prepare(
      "SELECT id, agent_group_id FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    )
    .get(payload.agentId) as { id: string; agent_group_id: string } | undefined;
  if (!session) fail(`No active session for agent ${payload.agentId}`);

  const inboundPath = path.join(root, 'data', 'v2-sessions', session.agent_group_id, session.id, 'inbound.db');
  if (!fs.existsSync(inboundPath)) fail(`Inbound DB not found: ${inboundPath}`);

  const inbound = new Database(inboundPath);
  try {
    const messageId = `remote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    inbound
      .prepare(
        `INSERT OR REPLACE INTO destinations
          (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES
          ('cody', 'Cody', 'channel', 'remote_cody', ?, NULL)`,
      )
      .run(payload.fromAgentId);
    inbound
      .prepare(
        `INSERT INTO messages_in
          (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content,
           process_after, recurrence, series_id, trigger, source_session_id, on_wake)
         VALUES
          (@id, @seq, 'chat', @timestamp, 'pending', @platformId, 'remote_cody', NULL, @content,
           NULL, NULL, @id, 1, NULL, 0)`,
      )
      .run({
        id: messageId,
        seq: nextEvenSeq(inbound),
        timestamp: new Date().toISOString(),
        platformId: payload.fromAgentId,
        content: JSON.stringify({
          sender: payload.fromName || 'Cody',
          text: payload.text,
        }),
      });
    console.log(messageId);
  } finally {
    inbound.close();
  }
} finally {
  central.close();
}
