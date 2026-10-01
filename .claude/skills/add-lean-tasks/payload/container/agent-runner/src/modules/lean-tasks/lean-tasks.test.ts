import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

let sdkCalls: Array<Record<string, unknown>> = [];
let sdkResult = 'done';

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    sdkCalls.push(args.options ?? {});
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-lean' };
      yield { type: 'result', subtype: 'success', result: sdkResult };
    })();
  },
}));

// The real barrels only: the hook and the wrapper exist when the modules
// barrel imports this skill.
await import('../index.js');
await import('../../providers/index.js');
await import('../../provider-contracts/index.js');
const { createProvider } = await import('../../providers/factory.js');
const { runPrepareQuery } = await import('../../turn-hooks.js');
const { MEMORY_SESSION_HOOK } = await import('../../memory/session-hook.js');
const { closeSessionDb, getInboundDb, initTestSessionDb } = await import('../../mailbox/sqlite/connection.js');
const { getUndeliveredMessages } = await import('../../db/messages-out.js');

import type { MessageInRow } from '../../db/messages-in.js';
import type { RoutingContext } from '../../formatter.js';
import type { ProviderEvent, QueryInput } from '../../providers/types.js';

const taskRouting: RoutingContext = {
  platformId: 'ag-1',
  channelType: 'agent',
  threadId: 'system:tasks:digest-a1b2',
  inReplyTo: 'run-1',
  taskRun: true,
};

function taskRow(content: Record<string, unknown>): MessageInRow {
  return {
    id: 'run-1',
    seq: 2,
    kind: 'task',
    timestamp: new Date().toISOString(),
    status: 'processing',
    process_after: null,
    recurrence: '0 9 * * *',
    series_id: 'digest-a1b2',
    tries: 0,
    trigger: 1,
    platform_id: null,
    channel_type: null,
    thread_id: 'system:tasks:digest-a1b2',
    content: JSON.stringify({ prompt: 'summarize', ...content }),
    source_session_id: null,
    on_wake: 0,
  };
}

async function runTurn(content: Record<string, unknown>, routing = taskRouting): Promise<ProviderEvent[]> {
  const provider = createProvider('claude', {
    assistantName: 'Ada',
    mcpServers: { nanoclaw: { command: 'bun', args: ['run', 'mcp.ts'] } },
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const base: QueryInput = {
    prompt: 'summarize',
    continuation: 'sess-chat',
    cwd: tmp,
    systemContext: { instructions: '# Full instructions' },
  };
  const input = await runPrepareQuery(base, { messages: [taskRow(content)], routing, followUp: false });
  const events: ProviderEvent[] = [];
  for await (const event of provider.query(input).events) events.push(event);
  return events;
}

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  sdkCalls = [];
  sdkResult = 'done';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-tasks-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  initTestSessionDb();
  const db = getInboundDb();
  db.prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('family', 'family', 'channel', 'telegram', 'telegram:99', NULL)`,
  ).run();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1), channel_type TEXT, platform_id TEXT, thread_id TEXT)`);
  db.prepare("INSERT OR REPLACE INTO session_routing (id, thread_id) VALUES (1, 'system:tasks:digest-a1b2')").run();
});

afterEach(() => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('lean task runs', () => {
  it('leave a task without lean on the full context', async () => {
    const events = await runTurn({});
    const options = sdkCalls[0];
    expect(options.resume).toBe('sess-chat');
    expect(options.settingSources).toEqual(['project', 'user', 'local']);
    expect(Object.keys(options.mcpServers as object)).toEqual(['nanoclaw']);
    expect(events.some((e) => e.type === 'init')).toBe(true);
  });

  it('leave a chat batch on the full context even with a lean-looking row', async () => {
    await runTurn({ lean: true }, { ...taskRouting, taskRun: false });
    expect(sdkCalls[0].settingSources).toEqual(['project', 'user', 'local']);
  });

  it('run a lean task with minimal context and no resume', async () => {
    const events = await runTurn({ lean: true });
    const options = sdkCalls[0];
    expect(options.resume).toBeUndefined();
    expect(options.settingSources).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.allowedTools).toEqual([]);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Read', 'Skill']));
    expect(typeof options.systemPrompt).toBe('string');
    expect(options.systemPrompt).toContain('You are Ada');
    expect(options.systemPrompt).toContain('family');
    expect(options.systemPrompt).not.toContain('Full instructions');
    // The lean session id never becomes the stored continuation.
    expect(events.some((e) => e.type === 'init')).toBe(false);
  });

  it('deliver message and card doors from the result and log what happened', async () => {
    sdkResult =
      'Checked.\n<message to="family">All good</message>\n<card to="family" title="Digest">3 items</card>\n' +
      '<message to="nobody">lost</message>';
    const events = await runTurn({ lean: true });

    const rows = getUndeliveredMessages();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'chat', platform_id: 'telegram:99', channel_type: 'telegram' });
    expect(JSON.parse(rows[0].content)).toEqual({ text: 'All good' });
    expect(rows[1]).toMatchObject({ kind: 'chat-sdk', platform_id: 'telegram:99' });
    expect(JSON.parse(rows[1].content)).toMatchObject({
      type: 'card',
      card: { title: 'Digest', description: '3 items' },
    });

    const result = events.find((e) => e.type === 'result');
    expect(result?.type === 'result' && result.text).toBe(
      'Checked.\n[sent → family] All good\n[card sent → family] Digest\n[not delivered → nobody] lost',
    );
  });

  it('pipe the result through the render command before the doors', async () => {
    sdkResult = 'All good';
    await runTurn({ lean: true, render: `sed 's|.*|<message to="family">&</message>|'` });

    expect(sdkCalls[0].systemPrompt).not.toContain('<message');
    const rows = getUndeliveredMessages();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content)).toEqual({ text: 'All good' });
  });
});
