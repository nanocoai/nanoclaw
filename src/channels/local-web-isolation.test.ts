import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { outboundDbPath } from '../mailbox/sqlite/paths.js';
import { openOutboundDbRw } from '../mailbox/sqlite/session-db.js';
import type { InboundMessage } from './adapter.js';

const { TEST_DATA_DIR } = vi.hoisted(() => ({ TEST_DATA_DIR: '/tmp/nanoclaw-test-local-web-isolation' }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, DATA_DIR: TEST_DATA_DIR };
});

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to allocate test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function startAdapter(): Promise<{
  registry: typeof import('./channel-registry.js');
  url: string;
  auth: Record<string, string>;
  actions: Array<{ questionId: string; selectedOption: string; userId: string }>;
}> {
  const port = await unusedPort();
  process.env.NANOCLAW_LOCAL_WEB_PORT = String(port);
  vi.resetModules();
  await import('../mailbox/compose.js');
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
  const registry = await import('./channel-registry.js');
  await import('./local-web.js');
  const actions: Array<{ questionId: string; selectedOption: string; userId: string }> = [];
  await registry.initChannelAdapters(() => ({
    onInbound: (_platformId: string, _threadId: string | null, _message: InboundMessage) => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: (questionId, selectedOption, userId) => void actions.push({ questionId, selectedOption, userId }),
  }));
  return {
    registry,
    url: `http://127.0.0.1:${port}`,
    auth: {
      'x-nanoclaw-local-web-token': fs.readFileSync(path.join(TEST_DATA_DIR, 'local-web', 'token'), 'utf8').trim(),
    },
    actions,
  };
}

async function seedConversations(): Promise<void> {
  const { createAgentGroup } = await import('../db/agent-groups.js');
  const { createMessagingGroup, createMessagingGroupAgent } = await import('../db/messaging-groups.js');
  const now = new Date().toISOString();
  for (const conversation of [
    { agentId: 'ag-one', groupId: 'mg-one', platformId: 'local-web:local', name: 'One' },
    { agentId: 'ag-two', groupId: 'mg-two', platformId: 'local-web:ag-two', name: 'Two' },
  ]) {
    await createAgentGroup({
      id: conversation.agentId,
      name: conversation.name,
      folder: conversation.agentId,
      agent_provider: null,
      created_at: now,
    });
    await createMessagingGroup({
      id: conversation.groupId,
      channel_type: 'local-web',
      platform_id: conversation.platformId,
      name: conversation.name,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    });
    await createMessagingGroupAgent({
      id: `mga-${conversation.agentId}`,
      messaging_group_id: conversation.groupId,
      agent_group_id: conversation.agentId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
  }
}

async function seedSession(agentGroupId: string, messagingGroupId: string, tool: string): Promise<void> {
  const { resolveSession } = await import('../session-manager.js');
  const { session } = await resolveSession(agentGroupId, messagingGroupId, null, 'shared');
  const outDb = openOutboundDbRw(outboundDbPath(agentGroupId, session.id));
  try {
    const now = new Date().toISOString();
    outDb
      .prepare(
        `INSERT INTO container_state
           (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
         VALUES (1, ?, NULL, ?, ?)`,
      )
      .run(tool, now, now);
  } finally {
    outDb.close();
  }
}

async function postMessage(
  url: string,
  auth: Record<string, string>,
  conversationId: string,
  text: string,
): Promise<Response> {
  return fetch(`${url}/api/messages`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ conversationId, text }),
  });
}

type CapturedStream = {
  events: Array<Record<string, unknown>>;
  close(): void;
};

async function captureStream(
  url: string,
  auth: Record<string, string>,
  conversationId: string,
): Promise<CapturedStream> {
  const abort = new AbortController();
  const response = await fetch(`${url}/events?conversationId=${encodeURIComponent(conversationId)}`, {
    headers: { ...auth, origin: url },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  const events: Array<Record<string, unknown>> = [];
  void (async () => {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as Record<string, unknown>);
        }
      }
    } catch (error: unknown) {
      if (!abort.signal.aborted) throw error;
    }
  })();
  await vi.waitFor(() => expect(events.some((event) => event.type === 'ready')).toBe(true));
  return { events, close: () => abort.abort() };
}

afterEach(async () => {
  delete process.env.NANOCLAW_LOCAL_WEB_PORT;
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('local web conversation isolation', () => {
  it('delivers each reply only to the stream for its platform identity', async () => {
    const { registry, url, auth } = await startAdapter();
    await seedConversations();
    const one = await captureStream(url, auth, 'mg-one');
    const two = await captureStream(url, auth, 'mg-two');
    try {
      const delivery = registry.createChannelDeliveryAdapter();
      await delivery.deliver(
        'local-web',
        'local-web:local',
        null,
        'chat',
        JSON.stringify({ text: 'reply one' }),
        undefined,
        'local-web',
      );
      await vi.waitFor(() => expect(one.events.some((event) => event.text === 'reply one')).toBe(true));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(two.events.some((event) => event.text === 'reply one')).toBe(false);

      await delivery.deliver(
        'local-web',
        'local-web:ag-two',
        null,
        'chat',
        JSON.stringify({ text: 'reply two' }),
        undefined,
        'local-web',
      );
      await vi.waitFor(() => expect(two.events.some((event) => event.text === 'reply two')).toBe(true));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(one.events.some((event) => event.text === 'reply two')).toBe(false);
    } finally {
      one.close();
      two.close();
      await registry.teardownChannelAdapters();
    }
  });

  it('samples and emits tool activity only for the addressed conversation', async () => {
    const { registry, url, auth } = await startAdapter();
    await seedConversations();
    await seedSession('ag-one', 'mg-one', 'Bash');
    await seedSession('ag-two', 'mg-two', 'Read');
    const one = await captureStream(url, auth, 'mg-one');
    const two = await captureStream(url, auth, 'mg-two');
    try {
      expect((await postMessage(url, auth, 'mg-one', 'one')).status).toBe(202);
      expect((await postMessage(url, auth, 'mg-two', 'two')).status).toBe(202);
      const delivery = registry.createChannelDeliveryAdapter();
      if (!delivery.setTyping) throw new Error('delivery adapter does not support typing');

      await delivery.setTyping('local-web', 'local-web:local', null, 'local-web');
      await vi.waitFor(() =>
        expect(one.events.some((event) => event.type === 'tool' && event.name === 'Bash')).toBe(true),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(two.events.some((event) => event.type === 'tool' && event.name === 'Bash')).toBe(false);

      await delivery.setTyping('local-web', 'local-web:ag-two', null, 'local-web');
      await vi.waitFor(() =>
        expect(two.events.some((event) => event.type === 'tool' && event.name === 'Read')).toBe(true),
      );
      expect(one.events.some((event) => event.type === 'tool' && event.name === 'Read')).toBe(false);
    } finally {
      one.close();
      two.close();
      await registry.teardownChannelAdapters();
    }
  });

  it('keeps questions and their resolutions in the owning conversation', async () => {
    const { registry, url, auth, actions } = await startAdapter();
    await seedConversations();
    const { createPendingApproval } = await import('../db/sessions.js');
    await createPendingApproval({
      approval_id: 'appr-one',
      request_id: 'appr-one',
      action: 'create_agent',
      payload: '{}',
      agent_group_id: 'ag-one',
      channel_type: 'local-web',
      platform_id: 'local-web:local',
      instance: 'local-web',
      created_at: new Date().toISOString(),
      title: 'Create one?',
      question: 'Only conversation one owns this.',
      options_json: JSON.stringify([{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }]),
    });
    const one = await captureStream(url, auth, 'mg-one');
    const two = await captureStream(url, auth, 'mg-two');
    try {
      await registry
        .createChannelDeliveryAdapter()
        .deliver(
          'local-web',
          'local-web:local',
          null,
          'chat-sdk',
          JSON.stringify({ type: 'ask_question', questionId: 'appr-one', title: 'Create one?', options: [] }),
          undefined,
          'local-web',
        );
      await vi.waitFor(() => expect(one.events.some((event) => event.type === 'question')).toBe(true));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(two.events.some((event) => event.type === 'question')).toBe(false);

      const crossConversation = await fetch(`${url}/api/actions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', origin: url },
        body: JSON.stringify({ conversationId: 'mg-two', questionId: 'appr-one', option: 0 }),
      });
      expect(crossConversation.status).toBe(404);
      expect(actions).toEqual([]);

      const action = await fetch(`${url}/api/actions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', origin: url },
        body: JSON.stringify({ conversationId: 'mg-one', questionId: 'appr-one', option: 0 }),
      });
      expect(action.status).toBe(202);
      expect(actions).toEqual([{ questionId: 'appr-one', selectedOption: 'approve', userId: 'local-web:local' }]);
      await vi.waitFor(() =>
        expect(
          one.events.some((event) => event.type === 'question-resolution' && event.questionId === 'appr-one'),
        ).toBe(true),
      );
      expect(two.events.some((event) => event.type === 'question-resolution')).toBe(false);
    } finally {
      one.close();
      two.close();
      await registry.teardownChannelAdapters();
    }
  });

  it('queues a background reply until its conversation is selected', async () => {
    const { registry, url, auth } = await startAdapter();
    await seedConversations();
    const one = await captureStream(url, auth, 'mg-one');
    let two: CapturedStream | undefined;
    try {
      await registry
        .createChannelDeliveryAdapter()
        .deliver(
          'local-web',
          'local-web:ag-two',
          null,
          'chat',
          JSON.stringify({ text: 'waiting for two' }),
          undefined,
          'local-web',
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(one.events.some((event) => event.text === 'waiting for two')).toBe(false);

      two = await captureStream(url, auth, 'mg-two');
      expect(two.events.some((event) => event.text === 'waiting for two')).toBe(true);
    } finally {
      one.close();
      two?.close();
      await registry.teardownChannelAdapters();
    }
  });
});
