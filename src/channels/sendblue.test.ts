import Database from 'better-sqlite3';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn(),
}));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    ...actual,
    DATA_DIR: path.join(os.tmpdir(), `nanoclaw-sendblue-${process.pid}`),
    GROUPS_DIR: path.join(os.tmpdir(), `nanoclaw-sendblue-${process.pid}`, 'groups'),
    getWebhookPort: () => 0,
  };
});

import '../modules/index.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { findSession } from '../db/sessions.js';
import { createUser } from '../modules/permissions/db/users.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import { inboundDbPath, outboundDbPath } from '../mailbox/sqlite/paths.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../delivery.js';
import { routeInbound } from '../router.js';
import { getWebhookStatus, stopWebhookServer } from '../webhook-server.js';
import { createSendblueAdapter, type SendblueConfig } from './sendblue.js';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';
import { SendblueDeliveryError } from './sendblue-delivery.js';

const ROOT = path.join(os.tmpdir(), `nanoclaw-sendblue-${process.pid}`);
const LINE = '+15555550100';
const SENDER = '+15555550101';
const CONFIG: SendblueConfig = {
  apiKey: 'fixture-key',
  apiSecret: 'fixture-secret',
  signingSecret: 'fixture-webhook-secret',
  fromNumber: LINE,
  allowFrom: [SENDER],
};
let adapter: ChannelAdapter;
let setup: ChannelSetup;
let provider: http.Server;
let sent: Array<Record<string, unknown>>;
let failProvider = false;
let disconnectProvider = false;

function event(changes: Record<string, unknown> = {}) {
  return {
    message_handle: 'fixture-inbound-1',
    is_outbound: false,
    status: 'RECEIVED',
    from_number: SENDER,
    to_number: LINE,
    content: 'Remember cobalt',
    group_id: '',
    ...changes,
  };
}
async function post(payload: unknown, secret = CONFIG.signingSecret) {
  const status = getWebhookStatus();
  return fetch(`http://127.0.0.1:${status!.port}/webhook/sendblue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sb-signing-secret': secret },
    body: JSON.stringify(payload),
  });
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  sent = [];
  failProvider = false;
  disconnectProvider = false;
  provider = http.createServer((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      expect(req.headers['sb-api-key-id']).toBe(CONFIG.apiKey);
      expect(req.headers['sb-api-secret-key']).toBe(CONFIG.apiSecret);
      sent.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (disconnectProvider) {
        res.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message_handle: `fixture-outbound-${sent.length}`,
          status: failProvider ? 'ERROR' : 'QUEUED',
          error_code: 0,
        }),
      );
    })();
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  adapter = createSendblueAdapter(CONFIG, (_url, options) =>
    fetch(`http://127.0.0.1:${address.port}/api/send-message`, options),
  );
  setup = { onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() };
  await adapter.setup(setup);
  await vi.waitFor(() => expect(getWebhookStatus()).not.toBeNull());
});
afterEach(async () => {
  await adapter.teardown();
  await stopWebhookServer();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('Sendblue native channel', () => {
  it('routes the real webhook through permissions and SQLite mailboxes, then delivers the outbox', async () => {
    const now = new Date().toISOString();
    await createAgentGroup({ id: 'agent', name: 'Test Agent', folder: 'agent', agent_provider: null, created_at: now });
    await createMessagingGroup({
      id: 'chat',
      channel_type: 'sendblue',
      platform_id: SENDER,
      name: 'Phone',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    await createMessagingGroupAgent({
      id: 'wire',
      messaging_group_id: 'chat',
      agent_group_id: 'agent',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    await createUser({ id: `sendblue:${SENDER}`, kind: 'human', display_name: 'Fixture owner', created_at: now });
    await grantRole({
      user_id: `sendblue:${SENDER}`,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });
    setup.onInbound = (platformId, threadId, message) =>
      routeInbound({
        channelType: 'sendblue',
        platformId,
        threadId,
        message: { ...message, content: JSON.stringify(message.content) },
      });
    expect((await post(event())).status).toBe(200);
    const session = await findSession('chat', null);
    expect(session).toBeDefined();
    const inbound = new Database(inboundDbPath('agent', session!.id));
    const rows = inbound.prepare('SELECT id, content FROM messages_in').all() as Array<{ id: string; content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('fixture-inbound-1:agent');
    expect(JSON.parse(rows[0].content)).toMatchObject({ text: 'Remember cobalt', senderId: `sendblue:${SENDER}` });
    inbound.close();
    expect((await post(event())).status).toBe(200);
    // Container/model edge is a deterministic writer; the actual host delivery poll reads its SQLite output.
    const outbound = new Database(outboundDbPath('agent', session!.id));
    outbound
      .prepare(
        'INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('fixture-reply', now, 'chat', SENDER, 'sendblue', JSON.stringify({ text: 'I remember cobalt.' }));
    outbound.close();
    setDeliveryAdapter({
      deliver: (_channel, platformId, threadId, kind, content) =>
        adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content) }),
    });
    await deliverSessionMessages(session!);
    expect(sent).toEqual([{ number: SENDER, from_number: LINE, content: 'I remember cobalt.' }]);
    const inDb = new Database(inboundDbPath('agent', session!.id));
    expect(
      inDb.prepare('SELECT status, platform_message_id FROM delivered WHERE message_out_id = ?').get('fixture-reply'),
    ).toMatchObject({ status: 'delivered', platform_message_id: 'fixture-outbound-1' });
    inDb.close();
    // An HTTP 200 provider rejection must become failed, not delivered and not replayed by the host.
    const outDb = new Database(outboundDbPath('agent', session!.id));
    outDb
      .prepare(
        'INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('fixture-reject', now, 'chat', SENDER, 'sendblue', JSON.stringify({ text: 'Rejected reply' }));
    outDb.close();
    failProvider = true;
    await deliverSessionMessages(session!);
    await deliverSessionMessages(session!);
    expect(sent).toHaveLength(2);
    const failedDb = new Database(inboundDbPath('agent', session!.id));
    expect(failedDb.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get('fixture-reject')).toEqual({
      status: 'failed',
    });
    failedDb.close();
    // Simulate acceptance followed by a broken response: the host must not replay it.
    const ambiguousDb = new Database(outboundDbPath('agent', session!.id));
    ambiguousDb
      .prepare(
        'INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('fixture-ambiguous', now, 'chat', SENDER, 'sendblue', JSON.stringify({ text: 'May have been sent' }));
    ambiguousDb.close();
    disconnectProvider = true;
    await deliverSessionMessages(session!);
    await deliverSessionMessages(session!);
    expect(sent).toHaveLength(3);
    const ambiguousResult = new Database(inboundDbPath('agent', session!.id));
    expect(
      ambiguousResult.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get('fixture-ambiguous'),
    ).toEqual({ status: 'failed' });
    ambiguousResult.close();
  });

  it.each([
    [{ is_outbound: true }, 200],
    [{ is_outbound: 'false' }, 200],
    [{ status: 'DELIVERED' }, 200],
    [{ group_id: 'g' }, 200],
    [{ to_number: '+15555550999' }, 200],
    [{ from_number: '+15555550999' }, 200],
    [{ content: {} }, 400],
    [{ message_handle: '' }, 400],
    [{ media_url: [] }, 400],
  ])('filters unsupported or malformed callback %j', async (changes, status) => {
    expect((await post(event(changes))).status).toBe(status);
    expect(setup.onInbound).not.toHaveBeenCalled();
  });
  it('authenticates and bounds the body', async () => {
    expect((await post(event(), 'wrong')).status).toBe(401);
    expect((await post([])).status).toBe(400);
    expect((await post(event({ content: 'x'.repeat(70000) }))).status).toBe(413);
    expect(setup.onInbound).not.toHaveBeenCalled();
  });
  it('allows retry after failed routing and deduplicates successful callbacks', async () => {
    setup.onInbound = vi
      .fn()
      .mockRejectedValueOnce(new Error('fixture store unavailable'))
      .mockResolvedValue(undefined);
    expect((await post(event())).status).toBe(503);
    expect((await post(event())).status).toBe(200);
    expect((await post(event())).status).toBe(200);
    expect(setup.onInbound).toHaveBeenCalledTimes(2);
  });
  it('renders question choices and binds answers to their recipient and question ID', async () => {
    await adapter.deliver(SENDER, null, {
      kind: 'chat',
      content: {
        type: 'ask_question',
        questionId: 'question-1',
        title: 'Approve?',
        question: 'Proceed with fixture?',
        options: ['Approve', 'Deny'],
      },
    });
    expect(sent[0].content).toContain('/sendblue question-1 NUMBER');
    expect((await post(event({ content: '/sendblue question-1 1' }))).status).toBe(200);
    expect(setup.onAction).toHaveBeenCalledWith('question-1', 'Approve', SENDER, {
      instance: 'sendblue',
      platformId: SENDER,
      threadId: null,
    });
    expect(setup.onInbound).not.toHaveBeenCalled();
  });
  it('does not download media or silently send unsupported output', async () => {
    expect((await post(event({ content: null, media_url: 'http://169.254.169.254/secret' }))).status).toBe(200);
    expect(setup.onInbound).toHaveBeenCalledWith(
      SENDER,
      null,
      expect.objectContaining({
        content: expect.objectContaining({ text: expect.stringContaining('supports text only') }),
      }),
    );
    await expect(
      adapter.deliver(SENDER, null, {
        kind: 'chat',
        content: { text: 'file' },
        files: [{ filename: 'x', data: Buffer.from('x') }],
      }),
    ).rejects.toBeInstanceOf(SendblueDeliveryError);
    expect(sent).toHaveLength(0);
  });
});
