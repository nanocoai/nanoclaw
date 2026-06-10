/**
 * Behavior test for how the tool-visibility hooks consume core: the
 * session-DB layer (`writeMessageOut` into outbound.db, `session_routing`
 * and `messages_in` reads from inbound.db).
 *
 * The wiring into the Claude provider is guarded separately by the
 * structural test (tool-visibility-wiring.test.ts); this test drives the
 * real hook callbacks against the real in-memory session DBs from
 * `initTestSessionDb()` and asserts a deliverable chat row lands in
 * messages_out. It goes red when core's outbound schema, the
 * session_routing shape, or the messages_in `kind` column drift away from
 * what the hook assumes.
 *
 * Note on ordering: tool-visibility.ts caches its task-session check
 * (latest messages_in.kind) once per process, so the first test seeds a
 * 'chat' message before any hook runs and the suite relies on that cached
 * non-task verdict throughout.
 *
 * Ships with the skill; apply copies it to container/agent-runner/src/hooks/.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { postToolUseVisibility, preToolUseVisibility } from './tool-visibility.js';

const hookOptions = { signal: new AbortController().signal };

function seedInbound(opts: { routing: boolean }): void {
  const { inbound } = initTestSessionDb();
  // The shipped test schema has no session_routing table (the host creates
  // it at spawn); add it here to mirror the real inbound.db.
  if (opts.routing) {
    inbound.exec(`
      CREATE TABLE IF NOT EXISTS session_routing (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        channel_type TEXT,
        platform_id  TEXT,
        thread_id    TEXT
      );
    `);
    inbound
      .prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)')
      .run('telegram', 'tg-12345', null);
  }
  inbound
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, content)
       VALUES ('m-1', 2, 'chat', ?, '{"text":"hi"}')`,
    )
    .run(new Date().toISOString());
}

function outboundRows(): Array<{ kind: string; platform_id: string | null; channel_type: string | null; content: string }> {
  return getOutboundDb()
    .prepare('SELECT kind, platform_id, channel_type, content FROM messages_out ORDER BY seq')
    .all() as Array<{ kind: string; platform_id: string | null; channel_type: string | null; content: string }>;
}

describe('tool-visibility hooks against the real session DBs', () => {
  beforeEach(() => {
    seedInbound({ routing: true });
  });

  test('PreToolUse(Bash) writes a deliverable chat preview into messages_out', async () => {
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    };
    await preToolUseVisibility(input as never, 'tu-1', hookOptions);

    const rows = outboundRows();
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('chat');
    expect(rows[0].platform_id).toBe('tg-12345');
    expect(rows[0].channel_type).toBe('telegram');
    const content = JSON.parse(rows[0].content) as { text: string };
    expect(content.text).toContain('git status');
    expect(content.text).toContain('🖥️');
  });

  test('PostToolUseFailure emits a failure marker with the error reason', async () => {
    const input = {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      error: 'exit code 1',
    };
    await postToolUseVisibility(input as never, 'tu-2', hookOptions);

    const rows = outboundRows();
    expect(rows.length).toBe(1);
    const content = JSON.parse(rows[0].content) as { text: string };
    expect(content.text).toContain('❌');
    expect(content.text).toContain('exit code 1');
  });

  test('a session without a reply lane stays silent (no messages_out row)', async () => {
    seedInbound({ routing: false });
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    await preToolUseVisibility(input as never, 'tu-3', hookOptions);
    expect(outboundRows().length).toBe(0);
  });
});
