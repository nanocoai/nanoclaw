/**
 * A Discord thread end to end against the real @chat-adapter/discord and the
 * real gateway approval coordinator: a raw Gateway message, the approval card
 * sent to the chat that message arrived in, then a raw click on that card.
 * Only fetch and the Gateway socket are stubbed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelRegistration } from './adapter.js';

const registrations = vi.hoisted(() => new Map<string, ChannelRegistration>());
const gateway = vi.hoisted(() => ({ url: '' }));

// The bridge starts a gateway listener on setup; keep it local and note where
// raw Gateway events are forwarded.
vi.mock('@chat-adapter/discord', async (importOriginal) => {
  const real = await importOriginal<typeof import('@chat-adapter/discord')>();
  return {
    ...real,
    createDiscordAdapter: (...args: Parameters<typeof real.createDiscordAdapter>) =>
      Object.assign(real.createDiscordAdapter(...args), {
        startGatewayListener: async (_options: unknown, _ms: number, _signal: unknown, url: string) => {
          gateway.url = url;
          return new Response('{}');
        },
      }),
  };
});

vi.mock('./channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channel-registry.js')>()),
  registerChannelAdapter: (name: string, registration: ChannelRegistration) => registrations.set(name, registration),
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    DISCORD_BOT_TOKEN: 'test-bot-token',
    DISCORD_PUBLIC_KEY: 'a'.repeat(64),
    DISCORD_APPLICATION_ID: 'bot-app',
  }),
}));

import { INSTALL_SLUG } from '../config.js';
import {
  closeDb,
  createAgentGroup,
  createSession,
  getPendingApproval,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { createMessagingGroup } from '../db/messaging-groups.js';
import type { ChannelDeliveryAdapter } from '../delivery.js';
import {
  gatewayRuntimeIdentity,
  type GatewayApprovalDecision,
  type GatewayApprovalRequest,
  type GatewayProviderDefinition,
} from '../gateway-providers/index.js';
import { dispatchResponse, type ResponseOutcome } from '../response-registry.js';
import './discord.js';

const API = 'https://discord.com/api/v10';
const realFetch = globalThis.fetch;

/** What the fake Discord API knows: each channel as `GET /channels/{id}` returns it. */
let channels: Record<string, { type: number; parent_id?: string }>;
let channelLookupFails: boolean;
/** Set by a test: Discord refuses every edit of a channel message. */
let cardEditsFail: boolean;
const posts: Array<{ channel: string; id: string; body: Record<string, unknown> }> = [];
const edits: Array<{ channel: string; id: string; body: Record<string, unknown> }> = [];
/** Writes to the clicked message through the interaction's own webhook. */
const interactionEdits: Array<Record<string, unknown>> = [];
/** Every write to a card after it was posted, in the order Discord got them. */
const cardWrites: string[] = [];
/** Card edits Discord has not answered yet, and whether a button removal arrived during one. */
let editsInFlight = 0;
let removedDuringEdit = false;
/** The buttons each card shows now. Discord keeps a message's buttons when an edit sends no components. */
const buttons = new Map<string, unknown>();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

vi.stubGlobal(
  'fetch',
  vi.fn(async (input: string | URL, init: { method?: string; body?: string } = {}) => {
    const url = String(input);
    if (!url.startsWith(API)) return realFetch(input, init as RequestInit);
    const path = url.slice(API.length);
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const channel = /^\/channels\/([^/]+)$/.exec(path);
    if (channel && method === 'GET') {
      if (channelLookupFails || !channels[channel[1]]) return json({ message: 'unavailable' }, 503);
      return json({ id: channel[1], ...channels[channel[1]] });
    }
    // A mention in a channel opens a thread on that message, under the message's
    // own id (an announcement thread in an announcement channel). Not inside a thread.
    const thread = /^\/channels\/([^/]+)\/messages\/([^/]+)\/threads$/.exec(path);
    if (thread && method === 'POST') {
      const parent = channels[thread[1]];
      if (!parent || parent.parent_id) return json({ message: 'Cannot start a thread in a thread' }, 400);
      channels[thread[2]] = { type: parent.type === 5 ? 10 : 11, parent_id: thread[1] };
      return json({ id: thread[2], name: body.name, ...channels[thread[2]] });
    }
    const message = /^\/channels\/([^/]+)\/messages(?:\/([^/]+))?$/.exec(path);
    if (message && method === 'POST') {
      posts.push({ channel: message[1], id: `card-${posts.length + 1}`, body });
      buttons.set(posts.at(-1)!.id, body.components ?? []);
      return json({ id: posts.at(-1)!.id, channel_id: message[1] });
    }
    if (message && method === 'PATCH') {
      edits.push({ channel: message[1], id: message[2], body });
      cardWrites.push('edit');
      // Slow enough that a removal sent alongside the edit would land inside it.
      editsInFlight++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      editsInFlight--;
      if (cardEditsFail) return json({ message: 'Internal Server Error' }, 500);
      if ('components' in body) buttons.set(message[2]!, body.components);
      return json({ id: message[2], channel_id: message[1] });
    }
    const original = /^\/webhooks\/[^/]+\/token-([^/]+)\/messages\/@original$/.exec(path);
    if (original && method === 'PATCH') {
      interactionEdits.push(body);
      if ('components' in body) buttons.set(original[1], body.components);
      cardWrites.push('buttons removed');
      if (editsInFlight > 0) removedDuringEdit = true;
    }
    // Interaction callbacks, private notes, typing: nothing to check here.
    return json({});
  }),
);

afterAll(() => {
  vi.unstubAllGlobals();
});

let decide: (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision>;
/** The gateway reports a request it ended itself. */
let endAtGateway: (requestId: string) => Promise<void>;
const submitted: Array<[string, string]> = [];

/** A gateway whose approvals outlive a restart: the coordinator then checks where a click came from. */
function durableGateway(): GatewayProviderDefinition {
  return {
    kind: 'fixture',
    agentSkills: ['fixture-gateway'],
    sessions: {
      async ensure() {
        return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
      },
    },
    approvals: {
      durable: true,
      decide: async (id, decision) => {
        submitted.push([id, decision]);
        return true;
      },
      listPending: async () => [],
      async subscribe(callback, signal, resolved) {
        decide = callback;
        endAtGateway = resolved!;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    },
  };
}

describe('a Discord thread, from the raw message to the raw click on its approval card', () => {
  let bridge: ChannelAdapter;
  const inbound: Array<{ platformId: string; threadId: string | null }> = [];
  const outcomes: ResponseOutcome[] = [];

  const forward = async (type: string, data: Record<string, unknown>) => {
    const response = await realFetch(gateway.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-discord-gateway-token': 'test-bot-token' },
      body: JSON.stringify({ type, timestamp: Date.now(), data }),
    });
    expect(response.status).toBe(200);
  };

  /** A MESSAGE_CREATE packet as the Gateway sends it; `channel_type` is optional there. */
  const rawMessage = (channelId: string, extra: Record<string, unknown> = {}) => ({
    id: 'M1',
    type: 0,
    channel_id: channelId,
    guild_id: 'G1',
    author: { id: 'U1', username: 'ada', global_name: 'Ada', bot: false },
    content: 'please run it',
    timestamp: new Date().toISOString(),
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    attachments: [],
    embeds: [],
    ...extra,
  });

  /** The click Discord sends for the first button of a posted card. */
  const rawClick = (card: (typeof posts)[number]) => {
    const rows = card.body.components as Array<{ components: Array<{ custom_id: string }> }>;
    return {
      type: 3,
      id: 'i1',
      token: `token-${card.id}`,
      application_id: 'bot-app',
      guild_id: 'G1',
      channel_id: card.channel,
      channel: { id: card.channel, ...channels[card.channel] },
      data: { custom_id: rows[0].components[0].custom_id },
      member: { user: { id: 'U1', username: 'ada', global_name: 'Ada' } },
      message: { id: card.id, channel_id: card.channel, embeds: card.body.embeds },
    };
  };

  /** The message arrives, and a card for a gateway request goes to the chat and thread it arrived in. */
  const messageThenCard = async (message: Record<string, unknown>, request: Partial<GatewayApprovalRequest> = {}) => {
    await forward('GATEWAY_MESSAGE_CREATE', message);
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    const { platformId, threadId } = inbound[0];
    await createMessagingGroup({
      id: 'mg-thread',
      channel_type: 'discord',
      platform_id: platformId,
      name: null,
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: new Date().toISOString(),
    });
    const decision = decide({
      id: 'native-request',
      agentGroupId: 'ag-1',
      sessionId: 'session-1',
      runtimeIdentity: gatewayRuntimeIdentity({
        installSlug: INSTALL_SLUG,
        agentGroupId: 'ag-1',
        sessionId: 'session-1',
      }),
      createdAt: new Date().toISOString(),
      title: 'Credential request',
      question: 'Allow POST api.example.test/resource?',
      audit: { method: 'POST', host: 'api.example.test' },
      approverUserId: 'discord:U1',
      delivery: { messagingGroupId: 'mg-thread', ...(threadId ? { threadId } : {}) },
      ...request,
    });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const [card] = posts;
    const approvalId = /^ncq:([^:]+):/.exec(rawClick(card).data.custom_id)![1];
    await vi.waitFor(async () => expect((await getPendingApproval(approvalId))?.platform_message_id).toBe(card.id));
    return { platformId, threadId, card, decision, approvalId };
  };

  /** The approver clicks Approve; resolves with what the host did. */
  const click = async (raw: Record<string, unknown>) => {
    const before = outcomes.length;
    await forward('GATEWAY_INTERACTION_CREATE', raw);
    await vi.waitFor(() => expect(outcomes.length).toBeGreaterThan(before));
    return outcomes.at(-1);
  };

  const messageThenCardThenClick = async (message: Record<string, unknown>) => {
    const sent = await messageThenCard(message);
    return { ...sent, outcome: await click(rawClick(sent.card)) };
  };

  beforeEach(async () => {
    inbound.length = posts.length = edits.length = outcomes.length = submitted.length = 0;
    interactionEdits.length = cardWrites.length = editsInFlight = 0;
    buttons.clear();
    removedDuringEdit = false;
    channelLookupFails = cardEditsFail = false;
    channels = { C1: { type: 0 }, T1: { type: 11, parent_id: 'C1' } };
    await runMigrations(await initTestDb());
    const now = new Date().toISOString();
    await createAgentGroup({ id: 'ag-1', name: 'Fixture', folder: 'fixture', agent_provider: null, created_at: now });
    await createSession({
      id: 'session-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now,
      created_at: now,
    });
    bridge = (await registrations.get('discord')!.factory())!;
    await bridge.setup({
      onInbound: (platformId, threadId) => void inbound.push({ platformId, threadId }),
      onInboundEvent: () => {},
      onMetadata: () => {},
      // As src/index.ts wires it.
      onAction: async (questionId, value, userId, address) => {
        const outcome = await dispatchResponse({
          questionId,
          value,
          userId,
          channelType: bridge.channelType,
          instance: address?.instance ?? bridge.instance ?? bridge.channelType,
          messageId: address?.messageId,
          platformId: address?.platformId ?? '',
          threadId: address?.threadId ?? null,
        });
        outcomes.push(outcome);
        return outcome;
      },
    });
    const delivery: ChannelDeliveryAdapter = {
      deliver: (_channelType, platformId, threadId, kind, content) =>
        bridge.deliver(platformId, threadId, { kind, content: JSON.parse(content) }),
    };
    const coordinator = await import('../gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator(durableGateway(), delivery, vi.fn());
  });

  afterEach(async () => {
    const coordinator = await import('../gateway-approval-coordinator.js');
    await coordinator.stopGatewayApprovalCoordinator();
    await bridge.teardown();
    await closeDb();
  });

  it('decides a click in a public thread the adapter keyed by its parent channel', async () => {
    const { platformId, threadId, card, decision, outcome } = await messageThenCardThenClick(
      rawMessage('T1', { channel_type: 11 }),
    );
    expect({ platformId, threadId, cardChannel: card.channel }).toEqual({
      platformId: 'discord:G1:C1',
      threadId: 'discord:G1:C1:T1',
      cardChannel: 'T1',
    });
    expect(outcome).toBe('accepted');
    expect(await decision).toBe('approve');
    expect(submitted).toEqual([['native-request', 'approve']]);
    await vi.waitFor(() => expect(edits.map((edit) => `${edit.channel}/${edit.id}`)).toContain('T1/card-1'));
  });

  // The host redraws a gateway card itself, and that edit clears the buttons:
  // the same edit closes a card nobody clicked. The click still removes them
  // once the host has accepted, for a redraw Discord refused.
  it("removes a decided gateway card's buttons through the click, after the host's redraw", async () => {
    const { outcome } = await messageThenCardThenClick(rawMessage('T1', { channel_type: 11 }));
    expect(outcome).toBe('accepted');
    await vi.waitFor(() => expect(cardWrites).toEqual(['edit', 'buttons removed']));
    expect(removedDuringEdit).toBe(false);
    expect(edits[0].body.components).toEqual([]);
    expect(JSON.stringify(edits[0].body.embeds)).toContain('Approved');
    expect(interactionEdits).toEqual([{ components: [] }]);
    expect(buttons.get('card-1')).toEqual([]);
  });

  // Nobody clicks, so there is no interaction to remove the buttons through:
  // the host's own closing edit has to.
  it.each([
    {
      name: 'times out',
      request: (): Partial<GatewayApprovalRequest> => ({ expiresAt: new Date(Date.now() + 1_800).toISOString() }),
      close: async () => {},
      resolution: 'Timed out',
    },
    {
      name: 'is ended at the gateway',
      request: (): Partial<GatewayApprovalRequest> => ({}),
      close: () => endAtGateway('native-request'),
      resolution: 'Request ended at the gateway',
    },
  ])("removes a gateway card's buttons when the request $name with nobody clicking", async (c) => {
    const { card, decision } = await messageThenCard(rawMessage('T1', { channel_type: 11 }), c.request());
    expect(buttons.get(card.id)).not.toEqual([]);
    await c.close();
    expect(await decision).not.toBe('approve');
    await vi.waitFor(() => expect(JSON.stringify(edits.at(-1)?.body.embeds)).toContain(c.resolution));
    expect(interactionEdits).toEqual([]);
    expect(buttons.get(card.id)).toEqual([]);
  });

  it("still removes a decided gateway card's buttons when Discord refuses the host's redraw", async () => {
    cardEditsFail = true;
    const { outcome, decision } = await messageThenCardThenClick(rawMessage('T1', { channel_type: 11 }));
    expect(outcome).toBe('accepted');
    expect(await decision).toBe('approve');
    // The host tried the whole card, then the card with its decision only.
    await vi.waitFor(() => expect(cardWrites).toEqual(['edit', 'edit', 'buttons removed']));
    expect(removedDuringEdit).toBe(false);
    expect(interactionEdits).toEqual([{ components: [] }]);
  });

  // The adapter keys a thread message by the thread alone when it can't tell
  // the parent: the channel lookup failed, or the packet named no channel type.
  it.each([
    ['its parent lookup fails', () => (channelLookupFails = true), { channel_type: 11 }],
    ['the packet names no channel type', () => {}, {}],
  ])('decides a click in a public thread keyed by the thread alone, when %s', async (_name, arrange, extra) => {
    arrange();
    const { platformId, threadId, card, decision, outcome } = await messageThenCardThenClick(rawMessage('T1', extra));
    expect({ platformId, threadId, cardChannel: card.channel }).toEqual({
      platformId: 'discord:G1:T1',
      threadId: 'discord:G1:T1',
      cardChannel: 'T1',
    });
    expect(outcome).toBe('accepted');
    expect(await decision).toBe('approve');
    expect(submitted).toEqual([['native-request', 'approve']]);
  });

  describe('in an announcement thread', () => {
    beforeEach(() => {
      channels = { C1: { type: 5 }, T1: { type: 10, parent_id: 'C1' } };
    });

    it('decides a click on a card sent after a mention opened the thread', async () => {
      const { platformId, threadId, card, decision, outcome } = await messageThenCardThenClick(
        rawMessage('C1', { channel_type: 5, mentions: [{ id: 'bot-app', username: 'bot' }] }),
      );
      // The new thread has the id of the message it was opened on.
      expect({ platformId, threadId, cardChannel: card.channel }).toEqual({
        platformId: 'discord:G1:C1',
        threadId: 'discord:G1:C1:M1',
        cardChannel: 'M1',
      });
      expect(channels.M1).toEqual({ type: 10, parent_id: 'C1' });
      expect(outcome).toBe('accepted');
      expect(await decision).toBe('approve');
    });

    // The adapter does not treat type 10 as a thread, so a later message in it
    // is keyed by the thread alone.
    it('decides a click on a card sent after a later message in the thread', async () => {
      const { platformId, threadId, card, decision, outcome } = await messageThenCardThenClick(
        rawMessage('T1', { channel_type: 10 }),
      );
      expect({ platformId, threadId, cardChannel: card.channel }).toEqual({
        platformId: 'discord:G1:T1',
        threadId: 'discord:G1:T1',
        cardChannel: 'T1',
      });
      expect(outcome).toBe('accepted');
      expect(await decision).toBe('approve');
    });
  });

  it.each([
    ['its parent channel', { channel_type: 11 }],
    ['the thread alone', {}],
  ])(
    'ignores the same card clicked from a thread of another channel, when the chat is keyed by %s',
    async (_name, extra) => {
      const { card, approvalId, decision } = await messageThenCard(rawMessage('T1', extra));
      channels.T2 = { type: 11, parent_id: 'C2' };
      const elsewhere = { ...rawClick(card), channel_id: 'T2', channel: { id: 'T2', ...channels.T2 } };
      expect(await click(elsewhere)).toBe('ignored');
      expect((await getPendingApproval(approvalId))?.status).toBe('pending');
      expect(submitted).toEqual([]);
      expect(cardWrites).toEqual([]);
      expect(await click(rawClick(card))).toBe('accepted');
      expect(await decision).toBe('approve');
    },
  );
});
