import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { applyAfterAgentCallHooks, applyBeforeAgentCallHooks, type AgentHooksConfig } from './agent-hooks.js';
import { initTestSessionDb, closeSessionDb, getOutboundDb, getInboundDb } from './db/connection.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';
import type { MessageInRow } from './db/messages-in.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

function message(id = 'm1', text = 'hello token=secret'): MessageInRow {
  return {
    id,
    seq: 1,
    kind: 'chat',
    timestamp: '2026-07-31T00:00:00Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'chan-1',
    channel_type: 'discord',
    thread_id: null,
    content: JSON.stringify({ sender: 'sorenfive', text }),
  };
}

function makeResultQuery(result: ProviderEvent): AgentQuery {
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return { push: () => {}, end: () => {}, events: events(), abort: () => {} };
}

function hookAuditRows(): unknown[] {
  const row = getOutboundDb().prepare("SELECT value FROM session_state WHERE key = 'agent_hook_runs'").get() as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as unknown[]) : [];
}

describe('agent call hooks', () => {
  it('runs before_agent_call hooks in priority order and mutates the prompt', async () => {
    const hooks: AgentHooksConfig = {
      before_agent_call: [
        {
          id: 'b-redact',
          priority: 20,
          runtime: 'builtin',
          procedure: 'regex_redact',
          config: { patterns: [{ regex: '(?i)TOKEN=\\w+' }] },
          on_error: 'block',
        },
        {
          id: 'a-prefix',
          priority: 10,
          runtime: 'command',
          command: [
            'sh',
            '-c',
            `cat >/dev/null; cat <<'JSON'
{"status":"mutate","mutations":{"request":{"prompt":"prefix token=secret"}},"reason":"prefixed"}
JSON`,
          ],
        },
      ],
    };

    const result = await applyBeforeAgentCallHooks({
      hooks,
      messages: [message()],
      prompt: 'token=secret',
      routing: ROUTING,
      providerName: 'mock',
      cwd: '/workspace/agent',
    });

    expect(result.status).toBe('continue');
    expect(result.prompt).toBe('prefix [REDACTED]');
    expect(result.audits.map((run) => run.id)).toEqual(['a-prefix', 'b-redact']);
    expect(hookAuditRows()).toHaveLength(2);
  });

  it('blocks when a required before_agent_call hook fails', async () => {
    const result = await applyBeforeAgentCallHooks({
      hooks: {
        before_agent_call: [{ id: 'bad', runtime: 'builtin', procedure: 'missing', required: true }],
      },
      messages: [message()],
      prompt: 'hello',
      routing: ROUTING,
      providerName: 'mock',
      cwd: '/workspace/agent',
    });

    expect(result.status).toBe('block');
    expect(result.reason).toContain('unsupported builtin hook procedure');
  });

  it('runs after_agent_call hooks before delivery', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('copilot', 'copilot', 'channel', 'discord', 'chan-1', NULL)`,
      )
      .run();

    const hooks: AgentHooksConfig = {
      after_agent_call: [
        {
          id: 'redact-output',
          runtime: 'builtin',
          procedure: 'regex_redact',
          config: { patterns: [{ regex: 'secret' }] },
          on_error: 'block',
        },
      ],
    };
    const query = makeResultQuery({ type: 'result', text: '<message to="copilot">secret</message>' });

    await processQuery(query, ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined, {
      hooks,
      cwd: '/workspace/agent',
    });

    const rows = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'chat'").all() as Array<{
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('[REDACTED]');
    expect(hookAuditRows()).toHaveLength(1);
  });

  it('blocks malformed post-call output with schema_validate', async () => {
    const result = await applyAfterAgentCallHooks({
      hooks: {
        after_agent_call: [
          {
            id: 'require-outcome',
            runtime: 'builtin',
            procedure: 'schema_validate',
            config: { required_fields: ['outcome'] },
          },
        ],
      },
      text: 'no matching field here',
      routing: ROUTING,
      providerName: 'mock',
      cwd: '/workspace/agent',
      prompt: 'prompt',
    });

    expect(result.status).toBe('block');
    expect(result.reason).toContain('outcome');
  });
});
