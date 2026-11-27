/**
 * Behavior tests for the tool-visibility hooks: pure input summarizers and
 * the session-DB layer (`writeMessageOut` into outbound.db, `session_routing`
 * and `messages_in` / `processing_ack` reads).
 *
 * The wiring into the Claude provider is guarded separately by the
 * structural test (tool-visibility-wiring.test.ts); this test drives the
 * real hook callbacks against the real in-memory session DBs from
 * `initTestSessionDb()` and asserts a deliverable chat row lands in
 * messages_out. It goes red when core's outbound schema, the
 * session_routing shape, or the messages_in / processing_ack contract
 * drifts away from what the hook assumes.
 *
 * Task-session suppression classifies on the in-flight processing_ack
 * batch (not a process-global cache of the latest messages_in.kind).
 * Tests that need tool-vis on seed a chat message + matching processing
 * ack; task-only wakes seed a task message + ack.
 *
 * Ships with the skill; apply copies it to container/agent-runner/src/hooks/.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import {
  describeToolInput,
  postToolUseVisibility,
  preToolUseVisibility,
  safeSlice,
  summarizeBash,
  summarizeHeredoc,
} from './tool-visibility.js';

const hookOptions = { signal: new AbortController().signal };

function seedInbound(opts: {
  routing: boolean;
  kind?: 'chat' | 'task';
  messageId?: string;
  processing?: boolean;
}): void {
  const { inbound, outbound } = initTestSessionDb();
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
  const messageId = opts.messageId ?? 'm-1';
  const kind = opts.kind ?? 'chat';
  inbound
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, content)
       VALUES (?, 2, ?, ?, '{"text":"hi"}')`,
    )
    .run(messageId, kind, new Date().toISOString());

  // isTaskSession() reads processing_ack for the in-flight batch. Seed a
  // matching ack so chat turns show tool-vis and task-only turns suppress.
  if (opts.processing !== false) {
    outbound
      .prepare(
        `INSERT INTO processing_ack (message_id, status, status_changed)
         VALUES (?, 'processing', ?)`,
      )
      .run(messageId, new Date().toISOString());
  }
}

function outboundRows(): Array<{ kind: string; platform_id: string | null; channel_type: string | null; content: string }> {
  return getOutboundDb()
    .prepare('SELECT kind, platform_id, channel_type, content FROM messages_out ORDER BY seq')
    .all() as Array<{ kind: string; platform_id: string | null; channel_type: string | null; content: string }>;
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

describe('tool-visibility pure summarizers', () => {
  test('safeSlice never leaves a lone UTF-16 high surrogate', () => {
    const line = 'x'.repeat(149) + '📊 rest';
    const cut = safeSlice(line, 150);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(cut.length).toBe(149);
    expect(safeSlice('hello world', 5)).toBe('hello');
    expect(safeSlice('a📊b', 3)).toBe('a📊');
  });

  test('describeToolInput prefers Bash description over command', () => {
    expect(
      describeToolInput('Bash', {
        description: 'Inspect the merge conflict',
        command: 'git status',
      }),
    ).toBe('Inspect the merge conflict');
    expect(describeToolInput('Bash', { description: 'x'.repeat(81), command: 'git status' })).toBe(
      `${'x'.repeat(80)}…`,
    );
  });

  test('describeToolInput falls back to summarized command without description', () => {
    expect(describeToolInput('Bash', { command: 'git status' })).toBe('`git status`');
  });

  test('summarizeBash skips pure assignment segments before the real command', () => {
    // Generic wrapper pattern: assign a launcher, then invoke it.
    const cmd = 'SSH_CMD="ssh -i /keys/id_ed25519" && $SSH_CMD root@host.example "df -h"';
    expect(summarizeBash(cmd)).toBe('ssh root@host.example: df -h');
  });

  test('summarizeBash collapses heredocs and bare bash scripts', () => {
    const heredoc = `python3 <<"PY"
import re
print("done")
PY`;
    expect(summarizeHeredoc(heredoc)).toBe('python3 «PY» import re…');
    expect(summarizeBash('bash /tmp/scripts/deploy.sh')).toBe('deploy.sh');
  });

  test('describeToolInput renders Skill and non-Bash tools', () => {
    expect(describeToolInput('Skill', { skill: 'add-discord' })).toBe('`add-discord`');
    expect(describeToolInput('Read', { file_path: '/tmp/example.ts' })).toBe('`/tmp/example.ts`');
    expect(describeToolInput('TodoWrite', { todos: [{}, {}] })).toBe('2 tasks');
  });
});

describe('tool-visibility hooks against the real session DBs', () => {
  beforeEach(() => {
    seedInbound({ routing: true, kind: 'chat' });
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
    const content = JSON.parse(rows[0].content) as { text: string; _toolVis?: boolean };
    expect(content.text).toContain('git status');
    expect(content.text).toContain('🖥️');
    expect(content._toolVis).toBe(true);
  });

  test('PreToolUse(Bash) prefers description in the preview line', async () => {
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { description: 'Check git status', command: 'git status --short' },
    };
    await preToolUseVisibility(input as never, 'tu-desc', hookOptions);
    const content = JSON.parse(outboundRows()[0].content) as { text: string };
    expect(content.text).toContain('Check git status');
    // Description-first: no redundant "bash" verb label, no backtick-wrapped command.
    expect(content.text).not.toMatch(/bash\s/);
    expect(content.text).not.toContain('git status --short');
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
    expect(content.text).toContain('·');
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

  test('empty TodoWrite is suppressed', async () => {
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'TodoWrite',
      tool_input: { todos: [] },
    };
    await preToolUseVisibility(input as never, 'tu-todo0', hookOptions);
    expect(outboundRows().length).toBe(0);
  });

  test('non-empty TodoWrite still emits', async () => {
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'a' }, { content: 'b' }] },
    };
    await preToolUseVisibility(input as never, 'tu-todo2', hookOptions);
    const content = JSON.parse(outboundRows()[0].content) as { text: string };
    expect(content.text).toContain('2 tasks');
    expect(content.text).toContain('📝');
  });

  test('task-only processing batch suppresses tool-vis', async () => {
    seedInbound({ routing: true, kind: 'task', messageId: 'task-1' });
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'df -h' },
    };
    await preToolUseVisibility(input as never, 'tu-task', hookOptions);
    expect(outboundRows().length).toBe(0);
  });

  test('mid-turn task row that is not in processing_ack does not silence a chat turn', async () => {
    // Interactive chat is the processing batch; a later cron task is only
    // pending in messages_in and must not flip tool-vis off.
    seedInbound({ routing: true, kind: 'chat', messageId: 'chat-1' });
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, content)
         VALUES ('cron-mid', 3, 'task', ?, '{"text":"monitor"}')`,
      )
      .run(new Date().toISOString());
    // No processing_ack for cron-mid — it is still pending.

    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo ok' },
    };
    await preToolUseVisibility(input as never, 'tu-chat', hookOptions);
    expect(outboundRows().length).toBe(1);
  });
});
