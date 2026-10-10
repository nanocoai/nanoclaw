import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { outboundDbPath } from '../mailbox/sqlite/paths.js';
import { openOutboundDbRw } from '../mailbox/sqlite/session-db.js';
import type { InboundMessage } from './adapter.js';

const { TEST_DATA_DIR } = vi.hoisted(() => ({ TEST_DATA_DIR: '/tmp/nanoclaw-test-local-web' }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, DATA_DIR: TEST_DATA_DIR, GROUPS_DIR: path.join(TEST_DATA_DIR, 'groups') };
});

vi.mock('../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

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

async function startAdapter(options: { routeMessages?: boolean } = {}) {
  const port = await unusedPort();
  process.env.NANOCLAW_LOCAL_WEB_PORT = String(port);
  vi.resetModules();
  await import('../mailbox/compose.js');
  const connection = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  const db = await connection.initTestDb();
  await runMigrations(db);
  await seedLegacyConversation();
  await import('../cli/resources/groups.js');
  await import('../cli/resources/messaging-groups.js');
  await import('../cli/resources/wirings.js');
  const registry = await import('./channel-registry.js');
  await import('./local-web.js');
  const inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
  const actions: Array<{ questionId: string; selectedOption: string; userId: string }> = [];
  await registry.initChannelAdapters(() => ({
    onInbound: async (platformId, threadId, message) => {
      inbound.push({ platformId, threadId, message });
      if (options.routeMessages) {
        const { routeInbound } = await import('../router.js');
        await routeInbound({
          channelType: 'local-web',
          instance: 'local-web',
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isGroup: message.isGroup,
          },
        });
      }
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: (questionId, selectedOption, userId) => void actions.push({ questionId, selectedOption, userId }),
  }));
  const auth = {
    'x-nanoclaw-local-web-token': fs.readFileSync(path.join(TEST_DATA_DIR, 'local-web', 'token'), 'utf8').trim(),
  };
  return { registry, inbound, actions, url: `http://127.0.0.1:${port}`, auth };
}

async function seedLegacyConversation(): Promise<void> {
  const { createAgentGroup } = await import('../db/agent-groups.js');
  const { createMessagingGroup, createMessagingGroupAgent } = await import('../db/messaging-groups.js');
  const now = new Date().toISOString();
  await createAgentGroup({
    id: 'ag-web',
    name: 'Web Agent',
    folder: 'web-agent',
    agent_provider: null,
    created_at: now,
  });
  await createMessagingGroup({
    id: 'mg-web',
    channel_type: 'local-web',
    platform_id: 'local-web:local',
    name: 'Local Web',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now,
  });
  await createMessagingGroupAgent({
    id: 'mga-web',
    messaging_group_id: 'mg-web',
    agent_group_id: 'ag-web',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
}

async function seedWebSession() {
  const { resolveSession } = await import('../session-manager.js');
  return resolveSession('ag-web', 'mg-web', null, 'shared');
}

afterEach(async () => {
  delete process.env.NANOCLAW_LOCAL_WEB_PORT;
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
  vi.clearAllMocks();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('local web adapter', () => {
  it('resolves host-initiated DMs to the live chat id so approval cards reach the browser', async () => {
    const { registry } = await startAdapter();
    try {
      // The approver handle parsed from user id `local-web:local` is the bare
      // `local`; without openDM the host delivers approval cards to a phantom
      // `local` messaging group that deliver() rejects. openDM must map any
      // handle back to the single id deliver() accepts.
      const adapter = registry.getChannelAdapter('local-web');
      expect(adapter?.openDM).toBeDefined();
      expect(await adapter!.openDM!('local')).toBe('local-web:local');
    } finally {
      await registry.teardownChannelAdapters();
    }
  });

  it('never turns browser connections into inbound messages', async () => {
    const { registry, inbound, url, auth } = await startAdapter();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    try {
      const first = await fetch(`${url}/events?conversationId=mg-web&welcome=1`, {
        headers: { ...auth, origin: url },
        signal: firstAbort.signal,
      });
      const firstReady = new TextDecoder().decode((await first.body!.getReader().read()).value);
      expect(firstReady).toContain('{"type":"ready"}');

      const second = await fetch(`${url}/events?conversationId=mg-web`, {
        headers: { ...auth, origin: url },
        signal: secondAbort.signal,
      });
      const secondReady = new TextDecoder().decode((await second.body!.getReader().read()).value);
      expect(secondReady).toContain('{"type":"ready"}');
      expect(inbound).toEqual([]);
    } finally {
      firstAbort.abort();
      secondAbort.abort();
      await registry.teardownChannelAdapters();
    }
  });

  // An agent container reaches this port through host.docker.internal, so an
  // unauthenticated /api/actions let a model resolve its own approval cards.
  it('rejects data and approval requests that do not carry the token', async () => {
    const { registry, actions, inbound, url, auth } = await startAdapter();
    const abort = new AbortController();
    try {
      const forged = { 'content-type': 'application/json', origin: url };
      const click = await fetch(`${url}/api/actions`, {
        method: 'POST',
        headers: forged,
        body: JSON.stringify({ conversationId: 'mg-web', questionId: 'q-1', option: 0 }),
      });
      expect(click.status).toBe(401);

      const wrongToken = await fetch(`${url}/api/actions`, {
        method: 'POST',
        headers: { ...forged, 'x-nanoclaw-local-web-token': 'not-the-token' },
        body: JSON.stringify({ conversationId: 'mg-web', questionId: 'q-1', option: 0 }),
      });
      expect(wrongToken.status).toBe(401);

      const message = await fetch(`${url}/api/messages`, {
        method: 'POST',
        headers: forged,
        body: JSON.stringify({ conversationId: 'mg-web', text: 'hello' }),
      });
      expect(message.status).toBe(401);

      const stream = await fetch(`${url}/events?conversationId=mg-web`, {
        headers: { origin: url },
        signal: abort.signal,
      });
      expect(stream.status).toBe(401);

      expect(actions).toEqual([]);
      expect(inbound).toEqual([]);

      // The shell must load before it can report having no token; the authorized
      // stream is the control that this is a gate and not a blanket 401.
      expect((await fetch(`${url}/`)).status).toBe(200);
      expect((await fetch(`${url}/local-web-chat.css`)).status).toBe(200);
      expect((await fetch(`${url}/local-web-conversations.css`)).status).toBe(200);
      expect((await fetch(`${url}/local-web-conversation-ui.js`)).status).toBe(200);
      expect(
        (
          await fetch(`${url}/events?conversationId=mg-web`, {
            headers: { ...auth, origin: url },
            signal: abort.signal,
          })
        ).status,
      ).toBe(200);
    } finally {
      abort.abort();
      await registry.teardownChannelAdapters();
    }
  });

  it('mints a 0600 token once and returns the same value on a re-read', async () => {
    const { registry, auth } = await startAdapter();
    try {
      const file = path.join(TEST_DATA_DIR, 'local-web', 'token');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const { readOrCreateToken } = await import('./local-web.js');
      expect(readOrCreateToken()).toBe(auth['x-nanoclaw-local-web-token']);
    } finally {
      await registry.teardownChannelAdapters();
    }
  });

  it('reads the service port persisted in .env', async () => {
    const originalCwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-local-web-'));
    try {
      fs.writeFileSync(path.join(directory, '.env'), 'NANOCLAW_LOCAL_WEB_PORT=43210\n');
      process.chdir(directory);
      vi.resetModules();
      const { configuredPort } = await import('./local-web.js');
      expect(configuredPort()).toBe(43210);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(directory, { recursive: true });
    }
  });

  it('lists only opaque conversation records behind the browser token', async () => {
    const { registry, url, auth } = await startAdapter();
    try {
      const response = await fetch(`${url}/api/conversations`, { headers: { ...auth, origin: url } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        installedProviders: expect.arrayContaining(['claude']),
        installationDefault: 'claude',
        isInstallationDefaultInstalled: true,
      });
      expect(body.conversations).toEqual([
        expect.objectContaining({ conversationId: 'mg-web', agentName: 'Web Agent', provider: 'claude' }),
      ]);
      expect(JSON.stringify(body)).not.toContain('platform_id');
      expect(JSON.stringify(body)).not.toContain('local-web:local');
      expect(JSON.stringify(body)).not.toContain('agentGroupId');
    } finally {
      await registry.teardownChannelAdapters();
    }
  });

  it('creates and resumes an agent through the narrow browser endpoint', async () => {
    const { registry, url, auth } = await startAdapter();
    try {
      const headers = { ...auth, 'content-type': 'application/json', origin: url };
      const extraAuthority = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Writer', agent_group_id: 'ag-picked-by-browser' }),
      });
      expect(extraAuthority.status).toBe(400);

      const missingSource = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Writer', sourceConversationId: 'missing' }),
      });
      expect(missingSource.status).toBe(404);

      const uninstalledProvider = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Researcher', provider: 'missing-provider' }),
      });
      expect(uninstalledProvider.status).toBe(409);

      const created = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Writer', sourceConversationId: 'mg-web' }),
      });
      expect(created.status).toBe(201);
      const first = (await created.json()) as { conversation: { conversationId: string } };
      const resumed = await fetch(`${url}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: ' writer ', sourceConversationId: 'mg-web' }),
      });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({
        created: false,
        conversation: { conversationId: first.conversation.conversationId, agentName: 'Writer', provider: 'claude' },
      });

      const { getDb } = await import('../db/connection.js');
      expect(
        await getDb().get<{
          groups: number;
          conversations: number;
          wirings: number;
          destinations: number;
          sessions: number;
        }>(
          `SELECT
             (SELECT COUNT(*) FROM agent_groups WHERE folder = 'web-writer') AS groups,
             (SELECT COUNT(*) FROM messaging_groups WHERE channel_type = 'local-web') AS conversations,
             (SELECT COUNT(*) FROM messaging_group_agents) AS wirings,
             (SELECT COUNT(*) FROM agent_destinations) AS destinations,
             (SELECT COUNT(*) FROM sessions) AS sessions`,
        ),
      ).toEqual({ groups: 1, conversations: 2, wirings: 2, destinations: 2, sessions: 0 });
    } finally {
      await registry.teardownChannelAdapters();
    }
  });

  it('routes browser messages through the web adapter', async () => {
    const { registry, inbound, url, auth } = await startAdapter();
    try {
      const health = (await (await fetch(`${url}/healthz`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ ok: true, channel: 'local-web' });
      expect(typeof health.install).toBe('string');

      const response = await fetch(`${url}/api/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', origin: url },
        body: JSON.stringify({ conversationId: 'mg-web', text: 'hello' }),
      });
      expect(response.status).toBe(202);
      expect(inbound).toHaveLength(1);
      expect(inbound[0]).toMatchObject({
        platformId: 'local-web:local',
        threadId: null,
      });
      expect(inbound[0].message.content).toMatchObject({ text: 'hello', senderId: 'local-web:local' });

      const blocked = await fetch(`${url}/api/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', origin: 'https://attacker.example' },
        body: JSON.stringify({ conversationId: 'mg-web', text: 'forged' }),
      });
      expect(blocked.status).toBe(403);
      expect(inbound).toHaveLength(1);
    } finally {
      await registry.teardownChannelAdapters();
    }
  });

  it('lets the first real message create the normal session and request a wake', async () => {
    const { registry, url, auth } = await startAdapter({ routeMessages: true });
    try {
      const response = await fetch(`${url}/api/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', origin: url },
        body: JSON.stringify({ conversationId: 'mg-web', text: 'first turn' }),
      });
      expect(response.status).toBe(202);

      const { getSessionsByAgentGroup } = await import('../db/sessions.js');
      const sessions = await getSessionsByAgentGroup('ag-web');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ messaging_group_id: 'mg-web', container_status: 'stopped' });
      const { withExistingMailboxSession } = await import('../session-manager.js');
      const history = await withExistingMailboxSession('ag-web', sessions[0]!.id, (mailbox) =>
        mailbox.getInboundHistory(10),
      );
      expect(history).toEqual([
        expect.objectContaining({ kind: 'chat', content: expect.stringContaining('first turn') }),
      ]);
      const { requestWake } = await import('../request-wake.js');
      expect(requestWake).toHaveBeenCalledOnce();
    } finally {
      await registry.teardownChannelAdapters();
    }
  });

  it('accepts the message limit and rejects one character over it', async () => {
    const { registry, inbound, url, auth } = await startAdapter();
    try {
      const accepted = await fetch(`${url}/api/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', origin: url },
        body: JSON.stringify({ conversationId: 'mg-web', text: 'a'.repeat(8_000) }),
      });
      const rejected = await fetch(`${url}/api/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', origin: url },
        body: JSON.stringify({ conversationId: 'mg-web', text: 'a'.repeat(8_001) }),
      });

      expect(accepted.status).toBe(202);
      expect(rejected.status).toBe(413);
      expect(inbound).toHaveLength(1);
    } finally {
      await registry.teardownChannelAdapters();
    }
  });

  it('streams replies delivered through the real channel delivery bridge', async () => {
    const { registry, url, auth } = await startAdapter();
    const abort = new AbortController();
    try {
      const response = await fetch(`${url}/events?conversationId=mg-web`, {
        headers: { ...auth, origin: url },
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      await registry.createChannelDeliveryAdapter().deliver(
        'local-web',
        'local-web:local',
        null,
        'chat',
        JSON.stringify({
          text: '# Agent reply\n\n[Safe](https://example.com) [unsafe](javascript:alert(1)) <script>x</script>',
        }),
        undefined,
        'local-web',
      );
      const delivered = new TextDecoder().decode((await reader.read()).value);
      const event = JSON.parse(delivered.slice(delivered.indexOf('data: ') + 6).trim()) as {
        text: string;
        html: string;
      };
      expect(event.text).toContain('# Agent reply');
      expect(event.html).toContain('<h1>Agent reply</h1>');
      expect(event.html).toContain('<a href="https://example.com">Safe</a>');
      expect(event.html).toContain('&lt;script&gt;x&lt;/script&gt;');
      expect(event.html).not.toContain('href="javascript:');
      expect(event.html).not.toContain('<script>');
    } finally {
      abort.abort();
      await registry.teardownChannelAdapters();
    }
  });

  it('delivers a queued reply without generating a browser message', async () => {
    const { registry, inbound, url, auth } = await startAdapter();
    const abort = new AbortController();
    try {
      await registry
        .createChannelDeliveryAdapter()
        .deliver(
          'local-web',
          'local-web:local',
          null,
          'chat',
          JSON.stringify({ text: 'waiting reply' }),
          undefined,
          'local-web',
        );

      const response = await fetch(`${url}/events?conversationId=mg-web`, {
        headers: { ...auth, origin: url },
        signal: abort.signal,
      });
      const reader = response.body!.getReader();
      const frames = new TextDecoder().decode((await reader.read()).value);
      expect(frames).toContain('waiting reply');
      expect(inbound).toEqual([]);
    } finally {
      abort.abort();
      await registry.teardownChannelAdapters();
    }
  });

  it('renders pending questions and resolves their server-owned option value', async () => {
    const { registry, actions, url, auth } = await startAdapter();
    const abort = new AbortController();
    try {
      const { createPendingApproval } = await import('../db/sessions.js');
      await createPendingApproval({
        approval_id: 'appr-local-web',
        request_id: 'appr-local-web',
        action: 'create_agent',
        payload: '{}',
        agent_group_id: 'ag-web',
        channel_type: 'local-web',
        platform_id: 'local-web:local',
        instance: 'local-web',
        created_at: new Date().toISOString(),
        title: 'Create ynet-researcher?',
        question: 'This creates a persistent agent.',
        options_json: JSON.stringify([
          { label: 'Approve', selectedLabel: 'Approved', value: 'approve', style: 'primary' },
          { label: 'Reject', selectedLabel: 'Rejected', value: 'reject', style: 'danger' },
        ]),
      });

      const response = await fetch(`${url}/events?conversationId=mg-web`, {
        headers: { ...auth, origin: url },
        signal: abort.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      const messageId = await registry.createChannelDeliveryAdapter().deliver(
        'local-web',
        'local-web:local',
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: 'appr-local-web',
          title: 'Create ynet-researcher?',
          question: 'This creates a persistent agent.',
          options: [],
        }),
        undefined,
        'local-web',
      );
      const delivered = new TextDecoder().decode((await reader.read()).value);
      expect(delivered).toContain('"type":"question"');
      expect(delivered).toContain('Create ynet-researcher?');
      expect(delivered).not.toContain('"value":"approve"');
      expect(messageId).toBe('appr-local-web');

      const blocked = await fetch(`${url}/api/actions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', origin: 'https://attacker.example' },
        body: JSON.stringify({ conversationId: 'mg-web', questionId: 'appr-local-web', option: 0 }),
      });
      expect(blocked.status).toBe(403);
      expect(actions).toEqual([]);

      const action = await fetch(`${url}/api/actions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', origin: url },
        body: JSON.stringify({ conversationId: 'mg-web', questionId: 'appr-local-web', option: 0 }),
      });
      expect(action.status).toBe(202);
      expect(actions).toEqual([{ questionId: 'appr-local-web', selectedOption: 'approve', userId: 'local-web:local' }]);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        '"type":"question-resolution","questionId":"appr-local-web","resolution":"Approved"',
      );

      await registry.createChannelDeliveryAdapter().deliver(
        'local-web',
        'local-web:local',
        null,
        'chat-sdk',
        JSON.stringify({
          operation: 'edit',
          messageId: 'appr-local-web',
          terminalCard: { resolution: 'Timed out' },
        }),
        undefined,
        'local-web',
      );
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"resolution":"Timed out"');
    } finally {
      abort.abort();
      await registry.teardownChannelAdapters();
    }
  });

  it('shows activity only until the first visible turn output', async () => {
    const { registry, url, auth } = await startAdapter();
    const abort = new AbortController();
    try {
      const { session } = await seedWebSession();
      const outDb = openOutboundDbRw(outboundDbPath('ag-web', session.id));
      try {
        const now = new Date().toISOString();
        outDb
          .prepare(
            `INSERT INTO container_state
               (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
             VALUES (1, 'Bash', NULL, ?, ?)`,
          )
          .run(now, now);
      } finally {
        outDb.close();
      }

      const response = await fetch(`${url}/events?conversationId=mg-web`, {
        headers: { ...auth, origin: url },
        signal: abort.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      const delivery = registry.createChannelDeliveryAdapter();
      if (!delivery.setTyping) throw new Error('delivery adapter does not support typing');
      await fetch(`${url}/api/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', origin: url },
        body: JSON.stringify({ conversationId: 'mg-web', text: 'hello' }),
      });
      await delivery.setTyping('local-web', 'local-web:local', null, 'local-web');
      const delivered = await reader.read();
      expect(new TextDecoder().decode(delivered.value)).toContain('{"type":"tool","name":"Bash"}');

      await delivery.deliver(
        'local-web',
        'local-web:local',
        null,
        'chat',
        JSON.stringify({ text: 'done' }),
        undefined,
        'local-web',
      );
      await reader.read();
      const settledDb = openOutboundDbRw(outboundDbPath('ag-web', session.id));
      try {
        settledDb.prepare('UPDATE container_state SET current_tool = NULL WHERE id = 1').run();
      } finally {
        settledDb.close();
      }
      await delivery.setTyping('local-web', 'local-web:local', null, 'local-web');

      await fetch(`${url}/api/messages`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', origin: url },
        body: JSON.stringify({ conversationId: 'mg-web', text: 'next' }),
      });
      const nextDb = openOutboundDbRw(outboundDbPath('ag-web', session.id));
      try {
        nextDb.prepare("UPDATE container_state SET current_tool = 'Read' WHERE id = 1").run();
      } finally {
        nextDb.close();
      }
      await delivery.setTyping('local-web', 'local-web:local', null, 'local-web');
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('{"type":"tool","name":"Read"}');
    } finally {
      abort.abort();
      await registry.teardownChannelAdapters();
    }
  });
});
