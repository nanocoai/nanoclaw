/**
 * Outbound email through the real Resend channel: registration factory, Chat SDK
 * bridge, and the installed `@resend/chat-sdk-adapter`, with only Resend's HTTP
 * API stubbed. Email is non-threaded, so the router hands `deliver()` a null
 * thread id and the platform id `resend:<address>`, which is not one of the
 * adapter's own thread ids.
 */
import crypto from 'crypto';

import type { Chat } from 'chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, InboundMessage } from './adapter.js';

const { WEBHOOK_SECRET } = vi.hoisted(() => ({
  WEBHOOK_SECRET: `whsec_${Buffer.from('resend-test-signing-key').toString('base64')}`,
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    RESEND_API_KEY: 're_test_key',
    RESEND_FROM_ADDRESS: 'bot@mail.example.com',
    RESEND_FROM_NAME: 'NanoClaw',
    RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
  }),
}));

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

import { resendRegistration } from './resend.js';

interface SentEmail {
  to: string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
  cc?: string[];
  bcc?: string[];
}

const INBOUND_EMAIL = {
  id: 'inbound-1',
  object: 'email',
  from: 'Owner <owner@example.com>',
  to: ['bot@mail.example.com'],
  cc: ['teammate@example.com'],
  subject: 'Weekly plan',
  text: 'Can you draft the weekly plan?',
  html: null,
  message_id: '<root-1@example.com>',
  headers: {},
  attachments: [],
  created_at: '2026-10-19T10:00:00.000Z',
};

const SECOND_EMAIL = {
  ...INBOUND_EMAIL,
  id: 'inbound-2',
  cc: [],
  subject: 'Budget',
  text: 'And the budget?',
  message_id: '<root-2@example.com>',
  created_at: '2026-10-19T11:00:00.000Z',
};

let sent: SentEmail[];

function stubResendApi(): void {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/emails') && init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)) as SentEmail);
        return Response.json({ id: `sent-${sent.length}` });
      }
      const email = [INBOUND_EMAIL, SECOND_EMAIL].find((e) => url.endsWith(`/emails/receiving/${e.id}`));
      if (email) return Response.json(email);
      return new Response('{"message":"unexpected request"}', { status: 404 });
    }),
  );
}

/** A webhook request signed the way Resend (svix) signs it. */
function signedWebhook(email: { id: string; created_at: string } = INBOUND_EMAIL): Request {
  const body = JSON.stringify({
    type: 'email.received',
    created_at: email.created_at,
    data: { email_id: email.id, attachments: [] },
  });
  const id = `msg_${email.id}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(WEBHOOK_SECRET.slice('whsec_'.length), 'base64');
  const signature = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return new Request('https://host.example.com/webhook/resend', {
    method: 'POST',
    headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
    body,
  });
}

describe('resend channel delivery', () => {
  let bridge: ChannelAdapter;
  let inbound: Array<{ platformId: string; message: InboundMessage }>;

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    stubResendApi();
    inbound = [];
    bridge = (await resendRegistration.factory())!;
    await bridge.setup({
      onInbound: (platformId, _threadId, message) => {
        inbound.push({ platformId, message });
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    });
  });

  afterEach(async () => {
    await bridge.teardown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  it('sends to a platform id with no thread (the "Connect yourself" hello)', async () => {
    const id = await bridge.deliver('resend:owner@example.com', null, {
      kind: 'chat',
      content: { text: 'Hi, I am your assistant.' },
    });

    expect(id).toBe('sent-1');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['owner@example.com']);
    expect(sent[0].text).toContain('Hi, I am your assistant.');
  });

  it('replies inside the email thread the person last wrote in', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const chat = vi.mocked(registerWebhookAdapter).mock.calls.at(-1)![0] as Chat;
    const handler = (chat.webhooks as Record<string, (r: Request) => Promise<Response>>).resend;

    expect((await handler(signedWebhook())).status).toBe(200);
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(inbound[0].platformId).toBe('resend:owner@example.com');

    await bridge.deliver(inbound[0].platformId, null, { kind: 'chat', content: { text: 'Here is the plan.' } });

    expect(sent).toHaveLength(1);
    // Only the sender: people CC'd on their email are not copied on the reply.
    expect(sent[0].to).toEqual(['owner@example.com']);
    expect(sent[0].cc).toBeUndefined();
    expect(sent[0].bcc).toBeUndefined();
    expect(sent[0].subject).toBe('Re: Weekly plan');
    expect(sent[0].headers?.['In-Reply-To']).toBe('<root-1@example.com>');
  });

  it('does not wait on the saved copy of the thread', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const chat = vi.mocked(registerWebhookAdapter).mock.calls.at(-1)![0] as Chat;
    const handler = (chat.webhooks as Record<string, (r: Request) => Promise<Response>>).resend;
    // Hold the state write: neither the inbound message nor the reply may wait on it.
    const state = chat.getState();
    const set = state.set.bind(state);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(state, 'set').mockImplementation(async (key: string, value: unknown, ttlMs?: number) => {
      if (key.startsWith('nanoclaw:resend:latest-thread:')) await held;
      return set(key, value, ttlMs);
    });

    expect((await handler(signedWebhook())).status).toBe(200);
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    await bridge.deliver('resend:owner@example.com', null, { kind: 'chat', content: { text: 'On it.' } });
    release();

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Re: Weekly plan');
  });

  it('replies in the newer thread when the person wrote twice', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const chat = vi.mocked(registerWebhookAdapter).mock.calls.at(-1)![0] as Chat;
    const handler = (chat.webhooks as Record<string, (r: Request) => Promise<Response>>).resend;

    expect((await handler(signedWebhook(INBOUND_EMAIL))).status).toBe(200);
    expect((await handler(signedWebhook(SECOND_EMAIL))).status).toBe(200);
    await vi.waitFor(() => expect(inbound).toHaveLength(2));
    await bridge.deliver('resend:owner@example.com', null, { kind: 'chat', content: { text: 'Both done.' } });

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Re: Budget');
    expect(sent[0].headers?.['In-Reply-To']).toBe('<root-2@example.com>');
  });

  it('opens a new thread after 30 days without mail from the person', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const chat = vi.mocked(registerWebhookAdapter).mock.calls.at(-1)![0] as Chat;
    const handler = (chat.webhooks as Record<string, (r: Request) => Promise<Response>>).resend;

    expect((await handler(signedWebhook())).status).toBe(200);
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000);
    await bridge.deliver('resend:owner@example.com', null, { kind: 'chat', content: { text: 'Still there?' } });

    expect(sent).toHaveLength(1);
    // A fresh thread from openDM has its own root, not the old email.
    expect(sent[0].headers?.['In-Reply-To']).toBeDefined();
    expect(sent[0].headers?.['In-Reply-To']).not.toBe('<root-1@example.com>');
  });

  it('keeps later sends to the same person in one thread', async () => {
    await bridge.deliver('resend:owner@example.com', null, { kind: 'chat', content: { text: 'First.' } });
    await bridge.deliver('resend:owner@example.com', null, { kind: 'chat', content: { text: 'Second.' } });

    expect(sent).toHaveLength(2);
    const root = sent[0].headers?.['In-Reply-To'];
    expect(root).toBeDefined();
    expect(sent[1].headers?.References?.split(' ')).toContain(root);
  });
});
