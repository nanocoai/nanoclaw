/**
 * One-door delivery in task sessions.
 *
 * Every outbound tool call names its destination. In a task run, final output
 * is inert delivery-wise and becomes the automatic run summary instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { sendFile, sendMessage } from './mcp-tools/core.js';
import { autoAppendTaskLog, buildTaskBlockNudge, dispatchResultText, shouldNudgeTaskBlocks } from './poll-loop.js';
import type { RoutingContext } from './formatter.js';

function seedSessionRouting(channelType: string | null, platformId: string | null, threadId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
  ).run(channelType, platformId, threadId);
}

function seedDestination(name = 'family', channelType = 'telegram', platformId = 'telegram:99'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

const taskRouting: RoutingContext = {
  platformId: 'ag-1',
  channelType: 'agent',
  threadId: 'system:tasks:daily-digest-a1b2',
  inReplyTo: 'run-1',
  taskRun: true,
};

beforeEach(() => {
  initTestSessionDb();
  seedDestination();
});

afterEach(() => {
  closeSessionDb();
});

describe('explicit outbound destinations', () => {
  it('derives task mode from the canonical per-series thread without a DB migration', () => {
    seedSessionRouting(null, null, 'system:tasks:daily-digest-a1b2');
    expect(getTaskSeriesId()).toBe('daily-digest-a1b2');

    seedSessionRouting('telegram', 'telegram:99', 'chat-thread');
    expect(getTaskSeriesId()).toBeNull();
  });

  it('requires `to` in both outbound tool schemas', () => {
    expect(sendMessage.tool.inputSchema.required).toContain('to');
    expect(sendFile.tool.inputSchema.required).toContain('to');
  });

  it('never infers the only destination when `to` is omitted', async () => {
    const messageResult = (await sendMessage.handler({ text: 'hello' })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const fileResult = (await sendFile.handler({ path: 'report.txt' })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    for (const result of [messageResult, fileResult]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('to is required');
      expect(result.content[0].text).toContain('family');
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects an unknown explicit destination without falling back', async () => {
    const messageResult = (await sendMessage.handler({ to: 'missing', text: 'hello' })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const fileResult = (await sendFile.handler({ to: 'missing', path: 'report.txt' })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    for (const result of [messageResult, fileResult]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown destination "missing"');
      expect(result.content[0].text).toContain('Known: family');
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('delivers to the explicitly named destination', async () => {
    seedSessionRouting(null, null, 'system:tasks:daily-digest-a1b2');

    await sendMessage.handler({ to: 'family', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('telegram:99');
  });

  it('preserves the current thread for an explicitly named matching destination', async () => {
    seedDestination('current-chat', 'discord', 'channel:1');
    seedSessionRouting('discord', 'channel:1', 'thread-7');

    await sendMessage.handler({ to: 'current-chat', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('channel:1');
    expect(out[0].thread_id).toBe('thread-7');
  });
});

describe('final-output blocks in a task run', () => {
  it('keeps them inert and returns their destination and content for correction', () => {
    const { sent, hasUnwrapped, taskBlocks } = dispatchResultText(
      '<message to="family">digest is ready</message>',
      taskRouting,
    );

    expect(sent).toBe(0);
    expect(hasUnwrapped).toBe(false);
    expect(taskBlocks).toEqual([{ to: 'family', body: 'digest is ready' }]);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('still delivers final-output blocks in chat sessions', () => {
    const { sent, taskBlocks } = dispatchResultText('<message to="family">hi</message>', {
      ...taskRouting,
      taskRun: false,
    });

    expect(sent).toBe(1);
    expect(taskBlocks).toEqual([]);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('nudges at most once and only when a task result contains inert blocks', () => {
    const blocks = [{ to: 'family', body: 'digest' }];
    expect(shouldNudgeTaskBlocks(true, blocks, false)).toBe(true);
    expect(shouldNudgeTaskBlocks(true, blocks, true)).toBe(false);
    expect(shouldNudgeTaskBlocks(true, [], false)).toBe(false);
    expect(shouldNudgeTaskBlocks(false, blocks, false)).toBe(false);
  });

  it('shows the exact content and makes re-send conditional', () => {
    const nudge = buildTaskBlockNudge([{ to: 'family', body: '3 <new> posts & a warning' }], 'family, ops');

    expect(nudge).toContain('to="family"');
    expect(nudge).toContain('3 &lt;new&gt; posts &amp; a warning');
    expect(nudge).toContain('If and only if');
    expect(nudge).toContain('do not send it again');
    expect(nudge).not.toContain('Re-send now');
  });

  it('records the original task result once, not the correction retry', () => {
    let nudged = false;
    const original = '<message to="family">digest</message>';
    const first = dispatchResultText(original, taskRouting);
    if (!nudged) autoAppendTaskLog(original);
    nudged = shouldNudgeTaskBlocks(true, first.taskBlocks, nudged);

    const retry = dispatchResultText('Delivery decision handled.', taskRouting);
    if (!nudged) autoAppendTaskLog('Delivery decision handled.');
    expect(shouldNudgeTaskBlocks(true, retry.taskBlocks, nudged)).toBe(false);

    const rows = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all() as {
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toContain('[undelivered → family] digest');
  });
});

describe('automatic task run summary', () => {
  it('writes a task_log row from final text', () => {
    autoAppendTaskLog('Checked  the\nfeeds — nothing new.');

    const rows = getOutboundDb().prepare("SELECT kind, content FROM messages_out WHERE kind = 'task_log'").all() as {
      kind: string;
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Checked the feeds — nothing new.');
  });

  it('marks legacy final-output blocks undelivered and never stores raw XML', () => {
    autoAppendTaskLog('Digest done. <message to="family">3 new posts today</message> See you tomorrow.');

    const row = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").get() as {
      content: string;
    };
    const line = JSON.parse(row.content).text as string;
    expect(line).not.toContain('<message');
    expect(line).toContain('[undelivered → family] 3 new posts today');
    expect(line).toContain('Digest done.');
  });

  it('is additive to an explicit append-log request', () => {
    writeMessageOut({
      id: 'cli-progress',
      kind: 'system',
      content: JSON.stringify({
        action: 'cli_request',
        requestId: 'cli-progress',
        command: 'tasks-append-log',
        args: { msg: 'progress note' },
      }),
    });

    autoAppendTaskLog('final summary');

    expect(getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE kind = 'task_log'").all()).toHaveLength(1);
  });
});
