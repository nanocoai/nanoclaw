import http from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, CardElement, RawMessage } from 'chat';

import { fenceForCard } from '../card-text.js';
import { gatewayApprovalPresentation } from '../gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from '../gateway-providers/gateway-provider-registry.js';
import { log } from '../log.js';
import { CardTooLongError } from './ask-question.js';
import {
  attachmentBytesToBase64,
  CARD_TEXT_BLOCK_LENGTH,
  createChatSdkBridge,
  splitCardText,
  splitForLimit,
} from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('attachmentBytesToBase64', () => {
  const bytes = Buffer.from('telegram attachment');
  const expected = bytes.toString('base64');

  it('encodes a Buffer', () => {
    expect(attachmentBytesToBase64(Buffer.from(bytes))).toBe(expected);
  });

  it('encodes an ArrayBuffer (Telegram fetchData since 4.39)', () => {
    const ab = new ArrayBuffer(bytes.length);
    new Uint8Array(ab).set(bytes);
    expect(attachmentBytesToBase64(ab)).toBe(expected);
  });

  it('encodes only the viewed range of a Uint8Array', () => {
    const backing = new Uint8Array(bytes.length + 4);
    backing.set(bytes, 2);
    expect(attachmentBytesToBase64(backing.subarray(2, 2 + bytes.length))).toBe(expected);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });

  it('reports an adapter transport probe when one is available', () => {
    let connected = false;
    const adapter = stubAdapter({}) as Adapter & { isConnected(): boolean };
    adapter.isConnected = () => connected;
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });

    expect(bridge.isConnected()).toBe(false);
    connected = true;
    expect(bridge.isConnected()).toBe(true);
  });

  it('keeps adapters without a transport probe available after setup', () => {
    const bridge = createChatSdkBridge({ adapter: stubAdapter({}), supportsThreads: true });
    expect(bridge.isConnected()).toBe(true);
  });
});

describe('createChatSdkBridge — instance identity', () => {
  it('default: name === channelType === adapter.name, instance undefined', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBeUndefined();
  });

  it('named instance: name follows the instance, channelType stays the platform', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack-tester');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBe('slack-tester');
  });

  it('rejects instance names that would break the webhook route or state delimiter', () => {
    for (const bad of ['a/b', 'a:b', 'a?b', 'a b']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });

  it('rejects empty and whitespace-only instance names (config bug — fail loud)', () => {
    // '' is falsy: a truthiness guard would skip it, dead-ending the
    // webhook route ('/webhook/' + '') and collapsing the state namespace
    // into the default instance's unprefixed keyspace — the exact
    // cross-bot dedupe/lock collisions the namespace exists to prevent.
    for (const bad of ['', ' ', '   ', '\t']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });
});

describe('createChatSdkBridge.setup — webhook route and state namespace', () => {
  // Real setup() over a stub adapter: Chat.initialize() needs a working
  // StateAdapter (chat_sdk_* tables) and an adapter.initialize — nothing
  // platform-side. registerWebhookAdapter is mocked at module level so we
  // can assert the (chat, adapterName, routingPath) triple.
  // runtimeMode is assigned inside initialize(), as the Telegram adapter does
  // when mode 'auto' resolves: a guard that reads it earlier sees undefined.
  function setupStubAdapter(runtimeMode?: 'webhook' | 'polling'): Adapter {
    const adapter = stubAdapter({ name: 'slack' }) as Adapter & { runtimeMode?: string };
    adapter.initialize = async () => {
      adapter.runtimeMode = runtimeMode;
    };
    return adapter;
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    vi.mocked(registerWebhookAdapter).mockClear();
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  const hostConfig = {
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };

  it('named instance registers the webhook with adapterName as handler key and instance as route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath).toBe('slack-tester');
    await bridge.teardown();
  });

  it('default instance registers the historical route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath ?? adapterName).toBe('slack');
    await bridge.teardown();
  });

  // Polling adapters (Telegram) pull updates themselves; a registered route
  // would lazily bind the shared webhook port, and a busy port then crashes a
  // Telegram-only host. Kill condition: delete the `runtimeMode === 'polling'`
  // branch in setup() and the polling case goes red.
  it('polling adapter (mode resolved inside initialize) registers no webhook route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter('polling'), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).not.toHaveBeenCalled();
    await bridge.teardown();
  });

  it('webhook adapter registers the route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter('webhook'), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('adapter without runtimeMode registers the route (non-Telegram adapters declare none)', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('named instance namespaces Chat SDK state; default stays unprefixed (live-install constraint)', async () => {
    const { getDb } = await import('../db/connection.js');

    const named = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await named.setup(hostConfig);
    await named.subscribe!('slack:C1', 'slack:T1');

    const def = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await def.setup(hostConfig);
    await def.subscribe!('slack:C1', 'slack:T1');

    const rows = await getDb().all<{ thread_id: string }>(
      'SELECT thread_id FROM chat_sdk_subscriptions ORDER BY thread_id',
    );
    expect(rows.map((r) => r.thread_id)).toEqual(['slack-tester:slack:T1', 'slack:T1']);

    await named.teardown();
    await def.teardown();
  });

  it('explicitly naming the primary instance after the platform stays on the unprefixed keyspace', async () => {
    const { getDb } = await import('../db/connection.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack', // explicit, but equal to adapter.name ⇒ default keyspace
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    await bridge.subscribe!('slack:C1', 'slack:T9');
    const rows = await getDb().all<{ thread_id: string }>('SELECT thread_id FROM chat_sdk_subscriptions');
    expect(rows.map((r) => r.thread_id)).toEqual(['slack:T9']);
    await bridge.teardown();
  });
});

describe('createChatSdkBridge.deliver — ask_question cards (button styles)', () => {
  // Approval cards color their buttons (Slack: primary→green, danger→red).
  // The bridge must forward the normalized option style into Button() and
  // omit it when unset — an invalid style surviving to Block Kit would fail
  // the whole card with invalid_blocks (effective auto-deny).

  interface CapturedButton {
    type?: string;
    id?: string;
    label?: string;
    value?: string;
    style?: string;
  }

  function buttonsFrom(calls: PostCall[]): CapturedButton[] {
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: CapturedButton[] }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    return actionsRow?.children ?? [];
  }

  it('passes each option style through to the Button, and omits it when unset', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-1',
        title: 'Approval needed',
        question: 'Allow the tool call?',
        options: [
          { label: 'Approve', style: 'primary' },
          { label: 'Deny', style: 'danger' },
          'Skip', // string shorthand — never styled
        ],
      },
    });
    expect(calls).toHaveLength(1);
    const buttons = buttonsFrom(calls);
    expect(buttons.map((b) => b.label)).toEqual(['Approve', 'Deny', 'Skip']);
    expect(buttons.map((b) => b.style)).toEqual(['primary', 'danger', undefined]);
  });

  it('drops invalid styles before they reach the Button (delivery goes through normalizeOptions)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-2',
        title: 'Approval needed',
        question: 'Allow the tool call?',
        options: [{ label: 'Approve', style: 'chartreuse' }],
      },
    });
    const buttons = buttonsFrom(calls);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].style).toBeUndefined();
  });

  it('retains the approval body and replaces buttons with a muted timeout resolution', async () => {
    const edits: PostCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        editMessage: async (threadId, _messageId, message) => {
          edits.push({ threadId, message });
          return { id: 'msg-1', threadId, raw: {} };
        },
      }),
      supportsThreads: false,
    });

    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'msg-1',
        text: 'Credentials Request\n\n*Agent:* Andy\n*Action:* Send email\n\n⏱️ Timed out — no response',
        terminalCard: {
          title: 'Credentials Request',
          question: '*Agent:* Andy\n*Action:* Send email',
          resolution: '⏱️ Timed out — no response',
        },
      },
    });

    expect(edits).toHaveLength(1);
    const edited = edits[0].message as {
      card: { title: string; children: Array<{ type: string; content?: string; style?: string }> };
    };
    expect(edited.card.title).toBe('Credentials Request');
    expect(edited.card.children).toEqual([
      { type: 'text', content: '*Agent:* Andy\n*Action:* Send email' },
      { type: 'text', content: '⏱️ Timed out — no response', style: 'muted' },
    ]);
    expect(edited.card.children.some((child) => child.type === 'actions')).toBe(false);
  });

  it('splits a long fenced host card into blocks that each keep their own fences', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      escapeCardText: (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    });
    const body = Array.from({ length: 150 }, (_, i) => `line ${i}: \`code\` <x|y> & more`).join('\n');

    await bridge.deliver('slack:D1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-long',
        title: 'Message approval',
        question: `Agent "A" wants to send a message to "B":\n\n${fenceForCard(body)}\n\nApprove?`,
        options: ['Approve'],
      },
    });
    const card = (calls[0].message as { card: { children: Array<{ type: string; content?: string }> } }).card;
    const blocks = card.children.filter((c) => c.type === 'text').map((c) => c.content!);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(CARD_TEXT_BLOCK_LENGTH);
      expect((block.match(/^ {0,3}```/gm) ?? []).length % 2).toBe(0);
      expect(block).not.toMatch(/[<>]/);
    }
  });

  it('leaves a question the agent asked itself (fromAgent) unescaped', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      escapeCardText: (t) => `[${t}]`,
    });

    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-4',
        title: 'Pick one',
        question: 'See <https://example.com|docs>?',
        options: ['Yes'],
        fromAgent: true,
      },
    });
    const posted = calls[0].message as {
      card: { children: Array<{ type: string; content?: string }> };
      fallbackText: string;
    };
    expect(posted.card.children[0]).toEqual({ type: 'text', content: 'See <https://example.com|docs>?' });
    expect(posted.fallbackText).toBe('Pick one\n\nSee <https://example.com|docs>?\nOptions: Yes');
  });

  it('runs open and resolved card text through escapeCardText, leaving the title alone', async () => {
    const { calls, postMessage } = makePostCapture();
    const edits: PostCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        postMessage,
        editMessage: async (threadId, _messageId, message) => {
          edits.push({ threadId, message });
          return { id: 'msg-1', threadId, raw: {} };
        },
      }),
      supportsThreads: false,
      escapeCardText: (t) => `[${t}]`,
    });

    await bridge.deliver('slack:D1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-3',
        title: 'Approval needed',
        question: 'Allow?',
        options: ['Approve'],
      },
    });
    const posted = calls[0].message as {
      card: { title: string; children: Array<{ type: string; content?: string }> };
      fallbackText: string;
    };
    expect(posted.card.title).toBe('Approval needed');
    expect(posted.card.children[0]).toEqual({ type: 'text', content: '[Allow?]' });
    expect(posted.fallbackText).toBe('Approval needed\n\n[Allow?]\nOptions: Approve');

    await bridge.deliver('slack:D1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'msg-1',
        terminalCard: { title: 'Approval needed', question: 'Allow?', resolution: 'Approve by Ann' },
      },
    });
    const edited = edits[0].message as {
      card: { title: string; children: Array<{ type: string; content?: string; style?: string }> };
    };
    expect(edited.card.title).toBe('Approval needed');
    expect(edited.card.children).toEqual([
      { type: 'text', content: '[Allow?]' },
      { type: 'text', content: '[Approve by Ann]', style: 'muted' },
    ]);
  });

  const CARD_TITLE = 'Approval needed';
  function questionCard(question: string, title = CARD_TITLE) {
    return {
      kind: 'chat-sdk',
      content: { type: 'ask_question', questionId: 'q-len', title, question, options: ['Approve'] },
    };
  }

  function postedCards(calls: PostCall[]) {
    return calls.map(({ message }) => {
      const card = (message as { card: { title?: string; children: Array<{ type: string; content?: string }> } }).card;
      return {
        title: card.title,
        text: card.children.filter((child) => child.type === 'text').map((child) => child.content ?? ''),
        hasButtons: card.children.some((child) => child.type === 'actions'),
      };
    });
  }

  function postedBlocks(calls: PostCall[]): { text: string[]; hasButtons: boolean } {
    const posted = calls[0].message as { card: { children: Array<{ type: string; content?: string }> } };
    return {
      text: posted.card.children.filter((child) => child.type === 'text').map((child) => child.content ?? ''),
      hasButtons: posted.card.children.some((child) => child.type === 'actions'),
    };
  }

  it('posts a full-size gateway summary card whole, in text blocks under the block cap', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({ adapter: stubAdapter({ postMessage }), supportsThreads: false });
    const { title, question } = gatewayApprovalPresentation({
      title: 'Legacy',
      question: 'Legacy question',
      summary: {
        agent: 'Nano',
        action: 'Read external data',
        resource: 'GET api.example.test/repos',
        reason: 'Policy requires approval',
        details: Array.from({ length: 6 }, (_, i) => ({ label: `Detail ${i}`, value: `${i}`.repeat(600) })),
      },
    } as GatewayApprovalRequest);
    expect(question.length).toBeGreaterThan(CARD_TEXT_BLOCK_LENGTH);

    await bridge.deliver('slack:D1', null, questionCard(question, title));
    const { text, hasButtons } = postedBlocks(calls);
    expect(text.length).toBeGreaterThan(1);
    for (const block of text) expect(block.length).toBeLessThanOrEqual(CARD_TEXT_BLOCK_LENGTH);
    expect(text.join('')).toBe(question);
    expect(hasButtons).toBe(true);
  });

  it("overflows a card over the channel's declared limit, counting the title", async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      maxCardTextLength: 300,
    });

    const fits = 'x'.repeat(300 - CARD_TITLE.length);
    await bridge.deliver('slack:D1', null, questionCard(fits));
    expect(postedCards(calls)).toEqual([{ title: CARD_TITLE, text: [fits], hasButtons: true }]);
    calls.length = 0;
    await bridge.deliver('slack:D1', null, questionCard(`${fits}x`));
    const cards = postedCards(calls);
    expect(cards.length).toBeGreaterThan(2);
    expect(cards.at(-1)!.hasButtons).toBe(true);
    for (const card of cards) expect((card.title ?? '').length + card.text.join('\n').length).toBeLessThanOrEqual(300);
  });

  it('counts the fences a split adds toward the declared limit', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      escapeCardText: (t) => t.replace(/&/g, '&amp;'),
      maxCardTextLength: 3000,
    });

    // Title + escaped text is exactly 3,000; the split's extra fences push it over.
    const question = '```\n' + '&'.repeat(598) + '\n```';
    await bridge.deliver('slack:D1', null, questionCard(question, 'OK'));
    const cards = postedCards(calls);
    expect(cards.length).toBeGreaterThan(1);
    expect(cards.slice(0, -1).some((card) => card.hasButtons)).toBe(false);
  });

  it('splits the resolved card the same way as the open one', async () => {
    const edits: PostCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        editMessage: async (threadId, _messageId, message) => {
          edits.push({ threadId, message });
          return { id: 'msg-1', threadId, raw: {} };
        },
      }),
      supportsThreads: false,
      escapeCardText: (t) => t.replace(/&/g, '&amp;'),
    });

    const question = '&'.repeat(1000);
    await bridge.deliver('slack:D1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'msg-1',
        terminalCard: { title: 'Approval needed', question, resolution: 'Approved' },
      },
    });
    const edited = edits[0].message as { card: { children: Array<{ content?: string; style?: string }> } };
    const blocks = edited.card.children.filter((child) => !child.style).map((child) => child.content ?? '');
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) expect(block.length).toBeLessThanOrEqual(CARD_TEXT_BLOCK_LENGTH);
    expect(blocks.join('')).toBe('&amp;'.repeat(1000));
    expect(edited.card.children.at(-1)).toEqual({ type: 'text', content: 'Approved', style: 'muted' });
  });

  it('measures the declared limit after escaping', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      escapeCardText: (t) => t.replace(/&/g, '&amp;'),
      maxCardTextLength: 300,
    });

    await bridge.deliver('slack:D1', null, questionCard('&'.repeat(70)));
    const cards = postedCards(calls);
    expect(cards.length).toBeGreaterThan(1);
    expect(cards.flatMap((card) => card.text.slice(1)).join('')).toContain('&amp;'.repeat(70));
  });

  describe('ask_question cards a channel cannot show whole', () => {
    // A stand-in channel that shows at most `max` characters of title plus text per card.
    const texts = (card: CardElement) =>
      card.children.flatMap((child) => (child.type === 'text' ? [child.content] : []));
    const hasActions = (card: CardElement) => card.children.some((child) => child.type === 'actions');
    const within = (max: number, card: { title?: string; text: string[] }) =>
      (card.title ?? '').length + card.text.join('\n').length <= max;
    const fitsWithin = (max: number) => (card: CardElement) => within(max, { title: card.title, text: texts(card) });
    const notice = (parts: number) => `The full request is in the ${parts} messages marked ref q-len above.`;
    /** The request text the parts carry, without their labels. */
    const partText = (parts: Array<{ text: string[] }>) => parts.flatMap((card) => card.text.slice(1)).join('');
    const LONG = Array.from({ length: 20 }, (_, i) => `Line ${i}: ${'w'.repeat(40)}`).join('\n');

    function numberedPosts(failOn?: number) {
      const calls: PostCall[] = [];
      const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
        if (calls.length + 1 === failOn) throw new Error('platform down');
        calls.push({ threadId, message });
        return { id: `msg-${calls.length}`, threadId, raw: {} };
      };
      return { calls, postMessage };
    }

    it('posts the full text first, then a short card with the buttons', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });

      const id = await bridge.deliver('slack:D1', null, questionCard(LONG));
      const cards = postedCards(calls);
      const parts = cards.slice(0, -1);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.some((card) => card.hasButtons)).toBe(false);
      expect(parts[0].title).toBe(CARD_TITLE);
      parts.forEach((card, i) => expect(card.text[0]).toBe(`Request ref q-len, part ${i + 1} of ${parts.length}`));
      expect(partText(parts)).toBe(LONG);
      expect(cards.at(-1)).toEqual({ title: CARD_TITLE, text: [notice(parts.length)], hasButtons: true });
      expect(id).toBe(`msg-${cards.length}`);
      for (const card of cards) expect(within(300, card)).toBe(true);
    });

    it('labels every part so concurrent requests stay apart, even with similar ids', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      const ask = (questionId: string, fill: string) =>
        bridge.deliver('slack:D1', null, {
          kind: 'chat-sdk',
          content: {
            type: 'ask_question',
            questionId,
            title: CARD_TITLE,
            question: fill.repeat(700),
            options: ['Approve'],
          },
        });
      await Promise.all([ask('ga-0000abcdef', 'a'), ask('ga-1111abcdef', 'b')]);
      for (const [ref, fill] of [
        ['ga-0000abcdef', 'a'],
        ['ga-1111abcdef', 'b'],
      ]) {
        const mine = postedCards(calls).filter((card) => card.text[0]?.includes(`ref ${ref}`));
        expect(partText(mine.filter((card) => !card.hasButtons))).toBe(fill.repeat(700));
        expect(mine.filter((card) => card.hasButtons)).toHaveLength(1);
      }
    });

    it('splits text smaller when one block does not fit a message', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(600),
      });
      const question = 'z'.repeat(1800);

      await bridge.deliver('slack:D1', null, questionCard(question));
      const cards = postedCards(calls);
      expect(partText(cards.slice(0, -1))).toBe(question);
      for (const card of cards) expect(within(600, card)).toBe(true);
    });

    it('moves a title too long for a part into the text', async () => {
      const { calls, postMessage } = numberedPosts();
      // Titles over 100 never fit; text up to 300 does.
      const cardFits = (card: CardElement) => (card.title ?? '').length <= 100 && fitsWithin(400)(card);
      const bridge = createChatSdkBridge({ adapter: stubAdapter({ postMessage }), supportsThreads: false, cardFits });
      const title = 'T'.repeat(150);

      await bridge.deliver('slack:D1', null, questionCard(LONG, title));
      const cards = postedCards(calls);
      const parts = cards.slice(0, -1);
      expect(parts[0].title).toBe('Approval request');
      expect(partText(parts)).toBe(`${title}\n\n${LONG}`);
      expect(cards.at(-1)!.title).toBe('Approval request');
      expect(cards.at(-1)!.hasButtons).toBe(true);
    });

    it("keeps an agent's own markup when its question overflows", async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        escapeCardText: (t) => t.replace(/&/g, '&amp;'),
        cardFits: fitsWithin(300),
      });
      const question = '**Pick** one & go\n'.repeat(40);
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          fromAgent: true,
          questionId: 'q-len',
          title: CARD_TITLE,
          question,
          options: ['Yes'],
        },
      });
      expect(partText(postedCards(calls).slice(0, -1))).toBe(question);
    });

    it('posts nothing when the text cannot fit even split', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: (card) => hasActions(card) && texts(card).join('').length < 60,
      });
      await expect(bridge.deliver('slack:D1', null, questionCard('x'.repeat(500)))).rejects.toThrow(CardTooLongError);
      expect(calls).toHaveLength(0);
    });

    it('refuses a card that would need more than 5 parts, posting nothing', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard('w'.repeat(3000)))).rejects.toThrow(
        'the request is too long to show in full on this channel',
      );
      expect(calls).toHaveLength(0);
      await bridge.deliver('slack:D1', null, questionCard('w'.repeat(1000)));
      expect(postedCards(calls).filter((card) => !card.hasButtons).length).toBeLessThanOrEqual(5);
    });

    it('refuses with the channel reason when no smaller split can be made', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      // Fits one 2,000 block, but a 300-backtick run can't be cut at the smaller sizes.
      const question = `${'x'.repeat(10)}\n${'`'.repeat(300)}`;
      await expect(bridge.deliver('slack:D1', null, questionCard(question))).rejects.toThrow(
        'the request is too long to show in full on this channel',
      );
      expect(calls).toHaveLength(0);
    });

    it('posts nothing when even the short card with the buttons cannot fit', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: (card) => !hasActions(card),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard('x'.repeat(500)))).rejects.toThrow(CardTooLongError);
      expect(calls).toHaveLength(0);
    });

    it('posts no buttons when part of the text fails to post', async () => {
      const { calls, postMessage } = numberedPosts(2);
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      expect(postedCards(calls).some((card) => card.hasButtons)).toBe(false);
    });

    /** Posts that fail only on the given attempt numbers (1-based), like a platform hiccup. */
    function flakyPosts(failAttempts: number[]) {
      const calls: PostCall[] = [];
      let attempt = 0;
      const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
        attempt += 1;
        if (failAttempts.includes(attempt)) throw new Error('platform down');
        calls.push({ threadId, message });
        return { id: `msg-${calls.length}`, threadId, raw: {} };
      };
      return { calls, postMessage };
    }
    const stopped = (posted: number, total: number) =>
      `Request ref q-len stopped after part ${posted} of ${total}. It can't be answered until all its parts and buttons arrive.`;
    const labelCount = (cards: Array<{ text: string[] }>, i: number) =>
      cards.filter((card) => /^Request ref q-len, part (\d+) of \d+$/.exec(card.text[0] ?? '')?.[1] === String(i))
        .length;

    it('notes a request whose posting stopped partway, and still fails', async () => {
      const { calls, postMessage } = flakyPosts([2]);
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      const cards = postedCards(calls);
      const total = Number(/ of (\d+)$/.exec(cards[0].text[0])![1]);
      expect(cards.map((card) => card.text.at(-1))).toEqual([cards[0].text.at(-1), stopped(1, total)]);
      expect(cards.some((card) => card.hasButtons)).toBe(false);
    });

    it('resumes a retry after the parts that already posted', async () => {
      const { calls, postMessage } = flakyPosts([2]);
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      await bridge.deliver('slack:D1', null, questionCard(LONG));
      const cards = postedCards(calls);
      const parts = cards.filter((card) => card.text[0]?.startsWith('Request ref q-len, part'));
      const total = parts.length;
      for (let i = 1; i <= total; i++) expect(labelCount(cards, i)).toBe(1);
      expect(partText(parts)).toBe(LONG);
      expect(cards.filter((card) => card.hasButtons)).toHaveLength(1);
      expect(cards.at(-1)!.hasButtons).toBe(true);
    });

    it('posts no note when nothing went out yet, and retries from the start', async () => {
      const { calls, postMessage } = flakyPosts([1]);
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      expect(calls).toHaveLength(0);
      await bridge.deliver('slack:D1', null, questionCard(LONG));
      const cards = postedCards(calls);
      expect(labelCount(cards, 1)).toBe(1);
      expect(cards.some((card) => card.text.some((text) => text.includes('stopped after')))).toBe(false);
    });

    it('notes a request whose buttons failed, and a retry posts only the buttons', async () => {
      const probe = numberedPosts();
      await createChatSdkBridge({
        adapter: stubAdapter({ postMessage: probe.postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      }).deliver('slack:D1', null, questionCard(LONG));
      const total = probe.calls.length - 1;

      const { calls, postMessage } = flakyPosts([total + 1]);
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      expect(postedCards(calls).at(-1)!.text).toEqual([stopped(total, total)]);
      const before = calls.length;
      await bridge.deliver('slack:D1', null, questionCard(LONG));
      expect(postedCards(calls.slice(before)).map((card) => card.hasButtons)).toEqual([true]);
    });

    it('starts over when a retry carries a different request', async () => {
      const { calls, postMessage } = flakyPosts([2]);
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      const before = calls.length;
      const changed = LONG.replace('Line 0', 'Line zero');
      await bridge.deliver('slack:D1', null, questionCard(changed));
      const retry = postedCards(calls.slice(before));
      expect(partText(retry.filter((card) => !card.hasButtons))).toBe(changed);
    });

    it('tries the note again when it failed to post before', async () => {
      const { calls, postMessage } = flakyPosts([2, 3, 4]);
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      const notes = postedCards(calls).filter((card) => card.text[0]?.includes('stopped after'));
      expect(notes).toHaveLength(1);
    });

    it('treats a repeat of a delivered request as already delivered', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      const id = await bridge.deliver('slack:D1', null, questionCard(LONG));
      const posted = calls.length;
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).resolves.toBe(id);
      expect(calls).toHaveLength(posted);
    });

    it('posts one copy when the same request is delivered twice at once', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      const [a, b] = await Promise.all([
        bridge.deliver('slack:D1', null, questionCard(LONG)),
        bridge.deliver('slack:D1', null, questionCard(LONG)),
      ]);
      expect(a).toBe(b);
      const cards = postedCards(calls);
      expect(labelCount(cards, 1)).toBe(1);
      expect(cards.filter((card) => card.hasButtons)).toHaveLength(1);
    });

    it('starts over when a retry carries different buttons', async () => {
      const { calls, postMessage } = flakyPosts([2]);
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      const retry = questionCard(LONG);
      retry.content.options = ['Reject'];
      await bridge.deliver('slack:D1', null, retry);
      expect(labelCount(postedCards(calls), 1)).toBe(2);
    });

    it('forgets saved parts once the request posts as one card', async () => {
      const { calls, postMessage } = flakyPosts([2]);
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      await bridge.deliver('slack:D1', null, questionCard('short'));
      await bridge.deliver('slack:D1', null, questionCard(LONG));
      expect(labelCount(postedCards(calls), 1)).toBe(2);
    });

    it('tells one option with a comma from two options', async () => {
      const { calls, postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      const one = questionCard(LONG);
      one.content.options = ['Approve, Reject'];
      await bridge.deliver('slack:D1', null, one);
      const two = questionCard(LONG);
      two.content.options = ['Approve', 'Reject'];
      await bridge.deliver('slack:D1', null, two);
      expect(postedCards(calls).filter((card) => card.hasButtons)).toHaveLength(2);
    });

    it('keeps saved parts when a whole card for the same id fails to post', async () => {
      const { calls, postMessage } = flakyPosts([2, 4]);
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await expect(bridge.deliver('slack:D1', null, questionCard(LONG))).rejects.toThrow('platform down');
      await expect(bridge.deliver('slack:D1', null, questionCard('short'))).rejects.toThrow('platform down');
      await bridge.deliver('slack:D1', null, questionCard(LONG));
      expect(labelCount(postedCards(calls), 1)).toBe(1);
    });

    it('reports the failure even when the stopped note hangs', async () => {
      vi.useFakeTimers();
      try {
        let attempt = 0;
        const postMessage = async (threadId: string): Promise<RawMessage<unknown>> => {
          attempt += 1;
          if (attempt === 2) throw new Error('platform down');
          if (attempt === 3) return new Promise<never>(() => {});
          return { id: `msg-${attempt}`, threadId, raw: {} };
        };
        const bridge = createChatSdkBridge({
          adapter: stubAdapter({ postMessage }),
          supportsThreads: false,
          cardFits: fitsWithin(300),
        });
        const delivery = bridge.deliver('slack:D1', null, questionCard(LONG));
        const outcome = expect(delivery).rejects.toThrow('platform down');
        await vi.advanceTimersByTimeAsync(5_000);
        await outcome;
      } finally {
        vi.useRealTimers();
      }
    });

    function editCapture() {
      const edits: PostCall[] = [];
      const editMessage = async (threadId: string, _messageId: string, message: AdapterPostableMessage) => {
        edits.push({ threadId, message });
        return { id: 'msg-1', threadId, raw: {} };
      };
      const editedTexts = () =>
        (edits[0].message as { card: { children: Array<{ content?: string }> } }).card.children.map(
          (child) => child.content,
        );
      return { edits, editMessage, editedTexts };
    }

    it('keeps a resolved card short when its request was posted above it', async () => {
      const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
      registerQuestionRenderResolver((id) => (id === 'q-len' ? { title: CARD_TITLE, options: [] } : undefined));
      const { editMessage, editedTexts } = editCapture();
      const { postMessage } = numberedPosts();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ editMessage, postMessage }),
        supportsThreads: false,
        cardFits: fitsWithin(300),
      });
      await bridge.deliver('slack:D1', null, questionCard('y'.repeat(1000)));
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          questionId: 'q-len',
          operation: 'edit',
          messageId: 'msg-1',
          terminalCard: { title: CARD_TITLE, question: 'y'.repeat(1000), resolution: 'Approved' },
        },
      });
      expect(editedTexts()).toEqual(['Request ref q-len', 'Approved']);
    });

    it('keeps the start of a request that no longer fits with its resolution, marked as cut', async () => {
      const { editMessage, editedTexts } = editCapture();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ editMessage }),
        supportsThreads: false,
        maxCardTextLength: 70,
      });
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'msg-1',
          terminalCard: { title: CARD_TITLE, question: 'x'.repeat(65), resolution: 'Approved' },
        },
      });
      // Posted whole, so there are no parts to point to; the resolved card has no buttons.
      const [text, resolution] = editedTexts() as string[];
      expect(text).toMatch(/^x+…$/);
      expect(resolution).toBe('Approved');
      expect(CARD_TITLE.length + text.length + 1 + resolution.length).toBeLessThanOrEqual(70);
    });

    it('shortens the title too when the original one leaves no room', async () => {
      const { edits, editMessage, editedTexts } = editCapture();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ editMessage }),
        supportsThreads: false,
        maxCardTextLength: 300,
      });
      const resolution = `Approved by ${'a'.repeat(80)}`;
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'msg-1',
          terminalCard: { title: 'T'.repeat(220), question: 'x'.repeat(250), resolution },
        },
      });
      expect((edits[0].message as { card: { title: string } }).card.title).toBe('Approval request');
      const [text, kept] = editedTexts() as string[];
      expect(text).toMatch(/^x+…$/);
      expect(kept).toBe(resolution);
    });

    it('lets the channel measure the styled card it will render', async () => {
      const { editMessage, editedTexts } = editCapture();
      // Like Discord: muted text renders wrapped in asterisks.
      const rendered = (card: CardElement) =>
        card.children.flatMap((child) =>
          child.type === 'text' ? [child.style === 'muted' ? `*${child.content}*` : child.content] : [],
        );
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ editMessage }),
        supportsThreads: false,
        cardFits: (card) => (card.title ?? '').length + rendered(card).join('\n').length <= 100,
      });
      // Title + text + resolution is exactly 100 unstyled; the asterisks push it over.
      const question = 'x'.repeat(100 - CARD_TITLE.length - 'Approved'.length - 1);
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'msg-1',
          terminalCard: { title: CARD_TITLE, question, resolution: 'Approved' },
        },
      });
      expect(editedTexts()).toEqual([question, 'Approved']);
    });

    it('keeps a resolution longer than one text block to its start', async () => {
      const { editMessage, editedTexts } = editCapture();
      const bridge = createChatSdkBridge({ adapter: stubAdapter({ editMessage }), supportsThreads: false });
      const resolution = `Approved by ann ${'y'.repeat(3001)}`;
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'msg-1',
          terminalCard: { title: CARD_TITLE, question: 'x', resolution },
        },
      });
      const texts = editedTexts() as string[];
      expect(texts[0]).toBe('x');
      expect(texts[1].startsWith('Approved by ann yyy')).toBe(true);
      expect(texts[1].endsWith('…')).toBe(true);
      expect(texts[1].length).toBeLessThanOrEqual(CARD_TEXT_BLOCK_LENGTH);
    });

    it('keeps the decision and who made it when the resolution alone does not fit', async () => {
      const { editMessage, editedTexts } = editCapture();
      const bridge = createChatSdkBridge({
        adapter: stubAdapter({ editMessage }),
        supportsThreads: false,
        maxCardTextLength: 300,
      });
      const resolution = `Approved by ann ${'a'.repeat(400)}`;
      await bridge.deliver('slack:D1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'msg-1',
          terminalCard: { title: CARD_TITLE, question: 'x', resolution },
        },
      });
      const [text] = editedTexts() as string[];
      expect(text.startsWith('Approved by ann aaa')).toBe(true);
      expect(text.endsWith('…')).toBe(true);
      expect(text.length).toBeLessThanOrEqual(300);
    });
  });
});

describe('splitCardText', () => {
  const ampEscape = (t: string) => t.replace(/&/g, '&amp;');

  it('keeps text that fits as one block', () => {
    expect(splitCardText('Allow?', (t) => t, 100)).toEqual(['Allow?']);
  });

  it('measures each block after escaping and never cuts an escape in half', () => {
    const blocks = splitCardText('&'.repeat(100), ampEscape, 42);
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(42);
      expect(block).toMatch(/^(&amp;)+$/);
    }
    expect(blocks.join('')).toBe(ampEscape('&'.repeat(100)));
  });

  it('splits at a line break when one is near the limit', () => {
    expect(splitCardText(`${'a'.repeat(30)}\n${'b'.repeat(30)}`, (t) => t, 40)).toEqual([
      `${'a'.repeat(30)}\n`,
      'b'.repeat(30),
    ]);
  });

  it('closes a code fence at the end of a block and reopens it in the next', () => {
    const text = 'Run:\n```\n' + 'y'.repeat(100) + '\n```';
    const blocks = splitCardText(text, (t) => t, 50);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(50);
      expect((block.match(/```/g) ?? []).length % 2).toBe(0);
    }
    // Each split inside the fence adds a closing and a reopening fence.
    expect(blocks.join('').split('\n``````\n').join('')).toBe(text);
  });

  it('never cuts a fence marker in half', () => {
    expect(splitCardText('x'.repeat(48) + '```\ncode\n```', (t) => t, 50)).toEqual([
      'x'.repeat(47),
      'x```\ncode\n```\n```',
    ]);
  });

  it('never moves backticks from mid-line to the start of a block', () => {
    const text = '```\n' + 'x'.repeat(42) + '```[link](https://e.x)\n' + 'y'.repeat(30) + '\n```';
    const blocks = splitCardText(text, (t) => t, 50);
    expect(blocks.some((block) => /^```\[/m.test(block))).toBe(false);
    expect(blocks.join('').split('\n``````\n').join('')).toBe(text);
  });

  it('treats backticks inside a code line as text, not a fence', () => {
    const blocks = splitCardText(
      '```\nprintf "```"\n' + 'x'.repeat(1980) + '\n**delete everything**\n```',
      (t) => t,
      2000,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].endsWith('\n```')).toBe(true);
    expect(blocks[1].startsWith('```\n')).toBe(true);
  });

  it('rechecks the length after backing off a long fence marker', () => {
    const blocks = splitCardText('```\n' + 'x'.repeat(1992) + '\n````\n' + 'y'.repeat(10), (t) => t, 2000);
    for (const block of blocks) expect(block.length).toBeLessThanOrEqual(2000);
  });

  it('never splits a surrogate pair', () => {
    const blocks = splitCardText('😀'.repeat(50), (t) => t, 31);
    for (const block of blocks) {
      expect(block).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    expect(blocks.join('')).toBe('😀'.repeat(50));
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('survives a null action instead of throwing on a property read', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [null, { label: 'Open', url: 'https://example.com' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const buttons = msg.card?.children?.find((c) => c.type === 'actions')?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('renders an unknown style as the default button style rather than dropping the action', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [
            { label: 'Open', url: 'https://example.com', style: 'chartreuse' },
            { label: 'Also', url: 'https://example.org', style: null },
          ],
        },
      },
    });
    const msg = calls[0].message as {
      card?: {
        children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string; style?: string }> }>;
      };
    };
    const buttons = msg.card?.children?.find((c) => c.type === 'actions')?.children ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].style).toBeUndefined();
    expect(buttons[1].style).toBeUndefined();
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

it('uses a registered approval presentation losslessly for initial and terminal cards', async () => {
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  const evidence = 'full evidence\n'.repeat(500);
  registerQuestionRenderResolver((id) =>
    id === 'presentation-fixture'
      ? {
          title: 'Review',
          options: [],
          deferResolution: true,
          renderMessage: () => ({ markdown: evidence }),
          renderTerminal: (resolution) => ({ markdown: `${evidence}\n${resolution}` }),
        }
      : undefined,
  );
  const { calls, postMessage } = makePostCapture();
  const edits: PostCall[] = [];
  const bridge = createChatSdkBridge({
    adapter: stubAdapter({
      postMessage,
      editMessage: async (threadId, _id, message) => {
        edits.push({ threadId, message });
        return { id: 'card', threadId, raw: {} };
      },
    }),
    supportsThreads: false,
  });
  await bridge.deliver('stub:C1', null, {
    kind: 'chat-sdk',
    content: {
      type: 'ask_question',
      questionId: 'presentation-fixture',
      title: 'Review',
      options: [],
      requirePresentation: true,
    },
  });
  expect(calls[0].message).toEqual({ markdown: evidence });
  await bridge.deliver('stub:C1', null, {
    kind: 'chat-sdk',
    content: {
      operation: 'edit',
      questionId: 'presentation-fixture',
      messageId: 'card',
      terminalCard: { resolution: 'Rejected' },
    },
  });
  expect(edits[0].message).toEqual({ markdown: `${evidence}\nRejected` });
});

it('forwards the authenticated instance and message address without editing a deferred approval', async () => {
  const { initTestDb, closeDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  await runMigrations(await initTestDb());
  registerQuestionRenderResolver((id) =>
    id === 'address-fixture'
      ? {
          title: 'Review',
          options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
          deferResolution: true,
        }
      : undefined,
  );
  const editMessage = vi.fn();
  const adapter = stubAdapter({
    name: 'fixture',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage,
  });
  const bridge = createChatSdkBridge({ adapter, instance: 'fixture-one', supportsThreads: false });
  const onAction = vi.fn();
  try {
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
    await chat.processAction(
      {
        actionId: 'ncq:address-fixture:0',
        adapter,
        messageId: 'original-card',
        raw: {},
        threadId: 'fixture:room',
        user: { userId: 'selected' } as never,
        value: '0',
      },
      undefined,
    );
    expect(onAction).toHaveBeenCalledWith('address-fixture', 'approve', 'selected', {
      instance: 'fixture-one',
      messageId: 'original-card',
      platformId: 'fixture:room',
      // The card's thread, so a handler can check the card it was sent as.
      threadId: 'fixture:room',
    });
    expect(editMessage).not.toHaveBeenCalled();
  } finally {
    await bridge.teardown();
    await closeDb();
  }
});

it('keeps the start of a clicked request that no longer fits with its resolution', async () => {
  const { initTestDb, closeDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  await runMigrations(await initTestDb());
  registerQuestionRenderResolver((id) =>
    id === 'click-overflow'
      ? {
          title: 'Review',
          question: 'q'.repeat(1000),
          options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
        }
      : undefined,
  );
  const editMessage = vi.fn();
  const adapter = stubAdapter({
    name: 'fixture',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage,
  });
  const bridge = createChatSdkBridge({
    adapter,
    instance: 'fixture-two',
    supportsThreads: false,
    cardFits: (card) =>
      (card.title ?? '').length +
        card.children.flatMap((child) => (child.type === 'text' ? [child.content] : [])).join('\n').length <=
      300,
  });
  try {
    // The host accepts the click.
    const onAction = vi.fn().mockResolvedValue('accepted');
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
    await chat.processAction(
      {
        actionId: 'ncq:click-overflow:0',
        adapter,
        messageId: 'button-card',
        raw: {},
        threadId: 'fixture:room',
        user: { userId: 'selected', userName: 'ann' } as never,
        value: '0',
      },
      undefined,
    );
    const edited = editMessage.mock.calls[0][2] as { card: { children: Array<{ content?: string }> } };
    const [text, resolution] = edited.card.children.map((child) => child.content);
    expect(text).toMatch(/^q+…$/);
    expect(resolution).toBe('Approved by ann');
  } finally {
    await bridge.teardown();
    await closeDb();
  }
});

it('edits a clicked card with no stored question into an escaped card, not raw markdown', async () => {
  const { initTestDb, closeDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  await runMigrations(await initTestDb());
  registerQuestionRenderResolver((id) =>
    id === 'click-plain'
      ? { title: '<!channel> Pick one', options: [{ label: 'Yes', selectedLabel: '<!here> Yes', value: 'yes' }] }
      : undefined,
  );
  const editMessage = vi.fn();
  const adapter = stubAdapter({
    name: 'fixture',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage,
  });
  const bridge = createChatSdkBridge({
    adapter,
    instance: 'fixture-three',
    supportsThreads: false,
    escapeCardText: (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  });
  try {
    // The host accepts the click.
    const onAction = vi.fn().mockResolvedValue('accepted');
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
    await chat.processAction(
      {
        actionId: 'ncq:click-plain:0',
        adapter,
        messageId: 'button-card',
        raw: {},
        threadId: 'fixture:room',
        user: { userId: 'selected', userName: 'ann' } as never,
        value: '0',
      },
      undefined,
    );
    const edited = editMessage.mock.calls[0][2] as {
      markdown?: string;
      card?: { title: string; children: Array<{ content?: string }> };
    };
    expect(edited.markdown).toBeUndefined();
    // The resolution is card text, so it's escaped; each channel escapes card titles itself.
    expect(edited.card?.title).toBe('<!channel> Pick one');
    expect(edited.card?.children.map((child) => child.content)).toEqual(['&lt;!here&gt; Yes by ann']);
  } finally {
    await bridge.teardown();
    await closeDb();
  }
});

it('keeps who decided when a channel cap forces a long label to be cut', async () => {
  const { initTestDb, closeDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  await runMigrations(await initTestDb());
  registerQuestionRenderResolver((id) =>
    id === 'click-long-label'
      ? { title: 'Review', options: [{ label: 'Yes', selectedLabel: 'L'.repeat(400), value: 'yes' }] }
      : undefined,
  );
  const editMessage = vi.fn();
  const adapter = stubAdapter({
    name: 'fixture',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage,
  });
  const bridge = createChatSdkBridge({
    adapter,
    instance: 'fixture-four',
    supportsThreads: false,
    maxCardTextLength: 300,
  });
  try {
    // The host accepts the click.
    const onAction = vi.fn().mockResolvedValue('accepted');
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
    await chat.processAction(
      {
        actionId: 'ncq:click-long-label:0',
        adapter,
        messageId: 'button-card',
        raw: {},
        threadId: 'fixture:room',
        user: { userId: 'selected', userName: 'Clicker' } as never,
        value: '0',
      },
      undefined,
    );
    const edited = editMessage.mock.calls[0][2] as { card: { children: Array<{ content?: string }> } };
    const resolution = edited.card.children.at(-1)?.content ?? '';
    expect(resolution).toMatch(/^L+… by Clicker$/);
    expect(resolution.length).toBeLessThanOrEqual(300);
  } finally {
    await bridge.teardown();
    await closeDb();
  }
});

it('leaves an already resolved card alone when a late click arrives', async () => {
  const { initTestDb, closeDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
  const editMessage = vi.fn();
  const adapter = stubAdapter({
    name: 'fixture',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage,
  });
  const onAction = vi.fn();
  const bridge = createChatSdkBridge({ adapter, instance: 'fixture-late', supportsThreads: false });
  try {
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
    await chat.processAction(
      {
        actionId: 'ncq:already-resolved:0',
        adapter,
        messageId: 'resolved-card',
        raw: {},
        threadId: 'fixture:room',
        user: { userId: 'selected', userName: 'Ann' } as never,
        value: '0',
      },
      undefined,
    );
    expect(editMessage).not.toHaveBeenCalled();
    // The host decides: it ignores a resolved question, and still handles a pending row without render metadata.
    expect(onAction).toHaveBeenCalledWith('already-resolved', '0', 'selected', expect.anything());
  } finally {
    await bridge.teardown();
    await closeDb();
  }
});

describe('createChatSdkBridge — a clicked card resolves only when the host accepts the click', () => {
  const review = {
    title: 'Review',
    question: 'Allow?',
    options: [{ label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' }],
  };

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  async function startClicks(questionId: string, render: Record<string, unknown>) {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
    await runMigrations(await initTestDb());
    registerQuestionRenderResolver((id) => (id === questionId ? (render as never) : undefined));
    const order: string[] = [];
    const editMessage = vi.fn(async () => {
      order.push('card edited');
      return { id: 'card-1', threadId: 'fixture:room', raw: {} };
    });
    const postEphemeral = vi.fn(async () => ({ id: 'note-1', threadId: 'fixture:room', usedFallback: false, raw: {} }));
    const adapter = stubAdapter({
      name: 'fixture',
      initialize: async () => {},
      channelIdFromThreadId: (threadId: string) => threadId,
      editMessage,
      postEphemeral,
    });
    const onAction = vi.fn();
    const bridge = createChatSdkBridge({ adapter, instance: `fixture-${questionId}`, supportsThreads: false });
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
    const click = (userId: string, userName: string) =>
      chat.processAction(
        {
          actionId: `ncq:${questionId}:0`,
          adapter,
          messageId: 'card-1',
          raw: {},
          threadId: 'fixture:room',
          user: { userId, userName } as never,
          value: '0',
        },
        undefined,
      );
    return { bridge, click, onAction, editMessage, postEphemeral, order };
  }

  it('keeps the buttons and tells only the clicker when a non-approver clicks', async () => {
    const { bridge, click, onAction, editMessage, postEphemeral } = await startClicks('q-refused', review);
    onAction.mockResolvedValue('refused');
    try {
      await click('bystander', 'Bob');
      expect(onAction).toHaveBeenCalledWith('q-refused', 'approve', 'bystander', expect.anything());
      // No "Approved by" edit: the card and its buttons stay for a real approver.
      expect(editMessage).not.toHaveBeenCalled();
      expect(postEphemeral).toHaveBeenCalledTimes(1);
      const [threadId, userId, note, options] = postEphemeral.mock.calls[0] as unknown as unknown[];
      expect([threadId, userId, options]).toEqual(['fixture:room', 'bystander', { fallbackToDM: false }]);
      expect(JSON.stringify(note)).toContain('Only an approver can answer this.');
    } finally {
      await bridge.teardown();
    }
  });

  it('edits the card only after the host accepts an approver click', async () => {
    const { bridge, click, onAction, editMessage, postEphemeral, order } = await startClicks('q-accepted', review);
    onAction.mockImplementation(async () => {
      order.push('host accepted');
      return 'accepted';
    });
    try {
      await click('approver', 'Ann');
      expect(order).toEqual(['host accepted', 'card edited']);
      const edited = editMessage.mock.calls[0] as unknown as [string, string, { card: CardElement }];
      expect(edited.slice(0, 2)).toEqual(['fixture:room', 'card-1']);
      expect(JSON.stringify(edited[2].card)).toContain('✅ Approved by Ann');
      expect(postEphemeral).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('a click the host ignores (nothing decided) leaves the card as it is', async () => {
    const { bridge, click, onAction, editMessage, postEphemeral } = await startClicks('q-ignored', review);
    onAction.mockResolvedValue('ignored');
    try {
      await click('approver', 'Ann');
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(editMessage).not.toHaveBeenCalled();
      expect(postEphemeral).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('tells a refused clicker privately on a card the host resolves itself', async () => {
    const { bridge, click, onAction, editMessage, postEphemeral } = await startClicks('q-gateway', {
      ...review,
      deferResolution: true,
    });
    onAction.mockResolvedValue('refused');
    try {
      await click('bystander', 'Bob');
      expect(editMessage).not.toHaveBeenCalled();
      expect(postEphemeral).toHaveBeenCalledWith('fixture:room', 'bystander', expect.anything(), {
        fallbackToDM: false,
      });
    } finally {
      await bridge.teardown();
    }
  });

  it('runs clicks on one card one at a time, so a quick second click waits for the first', async () => {
    const { bridge, click, onAction, editMessage } = await startClicks('q-concurrent', review);
    let accept!: () => void;
    onAction
      .mockImplementationOnce(() => new Promise((resolve) => (accept = () => resolve('accepted'))))
      .mockResolvedValueOnce('ignored');
    try {
      const first = click('approver', 'Ann');
      const second = click('approver', 'Ann');
      await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The second click waits for the first one's answer.
      expect(onAction).toHaveBeenCalledTimes(1);
      accept();
      await Promise.all([first, second]);
      expect(onAction).toHaveBeenCalledTimes(2);
      expect(editMessage).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
    }
  });

  it('a refused click leaves the card open for the approver', async () => {
    const { bridge, click, onAction, editMessage } = await startClicks('q-after-refusal', review);
    onAction.mockResolvedValueOnce('refused').mockResolvedValueOnce('accepted');
    try {
      await Promise.all([click('bystander', 'Bob'), click('approver', 'Ann')]);
      expect(onAction.mock.calls.map((call) => call[2])).toEqual(['bystander', 'approver']);
      expect(JSON.stringify(editMessage.mock.calls)).toContain('✅ Approved by Ann');
    } finally {
      await bridge.teardown();
    }
  });

  it('says a request is no longer available when the host closed it, naming nobody', async () => {
    const { bridge, click, onAction, editMessage } = await startClicks('q-closed', review);
    onAction.mockResolvedValue('closed');
    try {
      await click('approver', 'Ann');
      const card = JSON.stringify(editMessage.mock.calls[0]);
      expect(card).toContain('No longer available');
      expect(card).not.toContain('Ann');
    } finally {
      await bridge.teardown();
    }
  });

  it("draws a render's afterClick card as returned and posts its private note", async () => {
    const afterClick = vi.fn(async () => ({
      card: { markdown: 'Decided elsewhere' },
      privateNote: 'Only Cy can approve this.',
    }));
    const { bridge, click, onAction, editMessage, postEphemeral } = await startClicks('q-after', {
      ...review,
      afterClick,
    });
    onAction.mockResolvedValue('refused');
    try {
      await click('bystander', 'Bob');
      expect(afterClick).toHaveBeenCalledWith({
        outcome: 'refused',
        selectedOption: 'approve',
        userId: 'bystander',
        actorName: 'Bob',
        messageId: 'card-1',
        platformId: 'fixture:room',
        threadId: 'fixture:room',
      });
      expect(editMessage).toHaveBeenCalledWith('fixture:room', 'card-1', { markdown: 'Decided elsewhere' });
      expect(postEphemeral).toHaveBeenCalledWith('fixture:room', 'bystander', 'Only Cy can approve this.', {
        fallbackToDM: false,
      });
    } finally {
      await bridge.teardown();
    }
  });

  it('keeps the default when afterClick returns nothing or throws', async () => {
    for (const [questionId, afterClick] of [
      ['q-after-none', async () => undefined],
      ['q-after-throws', async () => Promise.reject(new Error('boom'))],
    ] as const) {
      const { bridge, click, onAction, editMessage } = await startClicks(questionId, { ...review, afterClick });
      onAction.mockResolvedValue('accepted');
      try {
        await click('approver', 'Ann');
        expect(JSON.stringify(editMessage.mock.calls[0])).toContain('✅ Approved by Ann');
      } finally {
        await bridge.teardown();
      }
    }
  });

  it('names the quoted card to the host where a click is a reply message', async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
    await runMigrations(await initTestDb());
    registerQuestionRenderResolver((id) => (id === 'q-reply-id' ? (review as never) : undefined));
    const adapter = stubAdapter({
      name: 'fixture',
      initialize: async () => {},
      channelIdFromThreadId: (threadId: string) => threadId,
      editMessage: vi.fn(),
    });
    const onAction = vi.fn().mockResolvedValue('accepted');
    // A button reply that arrives as its own message quoting the card (WhatsApp Cloud).
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: false,
      cardMessageIdOf: (event) => (event.raw as { context?: { id?: string } }).context?.id,
    });
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    try {
      const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
      await chat.processAction(
        {
          actionId: 'ncq:q-reply-id:0',
          adapter,
          messageId: 'reply-7',
          raw: { context: { id: 'card-3' } },
          threadId: 'fixture:room',
          user: { userId: 'approver', userName: 'Ann' } as never,
          value: '0',
        },
        undefined,
      );
      expect(onAction.mock.calls[0][3]).toEqual({
        instance: 'fixture',
        messageId: 'card-3',
        platformId: 'fixture:room',
        threadId: 'fixture:room',
      });
    } finally {
      await bridge.teardown();
    }
  });

  it("holds the card while a click's display runs, so a slow refused click can't overwrite a later decision", async () => {
    let releaseFirst!: () => void;
    const afterClick = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseFirst = () => resolve({ card: { markdown: 'Still waiting' } }))),
      )
      .mockResolvedValueOnce(undefined);
    const { bridge, click, onAction, editMessage } = await startClicks('q-hold-display', { ...review, afterClick });
    onAction.mockResolvedValueOnce('refused').mockResolvedValueOnce('accepted');
    try {
      const first = click('bystander', 'Bob');
      const second = click('approver', 'Ann');
      await vi.waitFor(() => expect(afterClick).toHaveBeenCalledTimes(1));
      releaseFirst();
      await Promise.all([first, second]);
      const edits = editMessage.mock.calls.map((call) => JSON.stringify(call));
      expect(edits.at(-1)).toContain('✅ Approved by Ann');
    } finally {
      await bridge.teardown();
    }
  });

  it("a click released by the hold cap never draws over a later click's decision", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let releaseFirst!: () => void;
    const afterClick = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseFirst = () => resolve({ card: { markdown: 'Still waiting' } }))),
      )
      .mockResolvedValueOnce(undefined);
    const { bridge, click, onAction, editMessage } = await startClicks('q-hold-cap', { ...review, afterClick });
    onAction.mockResolvedValueOnce('refused').mockResolvedValueOnce('accepted');
    try {
      const first = click('bystander', 'Bob');
      await vi.waitFor(() => expect(afterClick).toHaveBeenCalledTimes(1));
      const second = click('approver', 'Ann');
      // The first click stalls past the hold cap: the second one goes ahead and draws.
      await vi.advanceTimersByTimeAsync(10_001);
      await second;
      expect(JSON.stringify(editMessage.mock.calls.at(-1))).toContain('✅ Approved by Ann');
      releaseFirst();
      await first;
      expect(JSON.stringify(editMessage.mock.calls)).not.toContain('Still waiting');
    } finally {
      vi.useRealTimers();
      await bridge.teardown();
    }
  });

  it("a decision that takes longer than the hold cap still draws over a refused click's card", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let decide!: () => void;
    const afterClick = vi.fn(async ({ outcome }: { outcome?: string }) =>
      outcome === 'refused' ? { card: { markdown: 'Only Ann can approve this' } } : undefined,
    );
    const { bridge, click, onAction, editMessage } = await startClicks('q-slow-decision', { ...review, afterClick });
    onAction
      .mockImplementationOnce(() => new Promise((resolve) => (decide = () => resolve('accepted'))))
      .mockResolvedValueOnce('refused');
    try {
      const first = click('approver', 'Ann');
      await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
      const second = click('bystander', 'Bob');
      // A cold start: the decision outlasts the hold cap, so the refused click goes first.
      await vi.advanceTimersByTimeAsync(10_001);
      await second;
      decide();
      await first;
      expect(JSON.stringify(editMessage.mock.calls.at(-1))).toContain('✅ Approved by Ann');
    } finally {
      vi.useRealTimers();
      await bridge.teardown();
    }
  });

  it('posts nothing for a refused click where the channel has no private messages', async () => {
    const { bridge, click, onAction, editMessage, postEphemeral } = await startClicks('q-no-private', review);
    onAction.mockResolvedValue('refused');
    postEphemeral.mockRejectedValue(new Error('not supported'));
    try {
      await click('bystander', 'Bob');
      expect(editMessage).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });
});

describe('createChatSdkBridge — local Gateway webhook', () => {
  // The Gateway listener forwards raw events to a loopback server; only it may
  // post there. It sends the bot token in x-discord-gateway-token.
  const BOT_TOKEN = 'test-bot-token';
  const realFetch = globalThis.fetch;

  const click = JSON.stringify({
    type: 'GATEWAY_INTERACTION_CREATE',
    data: {
      type: 3,
      id: 'interaction-1',
      token: 'interaction-token',
      channel_id: 'chan-1',
      data: { custom_id: 'ncq:q-1:approve' },
      member: { user: { id: 'clicker-1', username: 'clicker' } },
      message: { id: 'card-1', embeds: [] },
    },
  });
  const message = JSON.stringify({ type: 'GATEWAY_MESSAGE_CREATE', data: { id: 'm-1', content: 'hi' } });

  async function startGateway(botToken?: string) {
    let webhookUrl = '';
    const handleWebhook = vi.fn(async () => new Response('ok'));
    const adapter = stubAdapter({
      name: 'discord',
      initialize: async () => {},
      handleWebhook,
      channelIdFromThreadId: (threadId: string) => threadId,
      encodeThreadId: ({ guildId, channelId }: { guildId: string; channelId: string }) =>
        `discord:${guildId}:${channelId}`,
    } as never) as Adapter & { startGatewayListener: unknown };
    adapter.startGatewayListener = async (_opts: unknown, _ms: number, _signal: AbortSignal, url: string) => {
      webhookUrl = url;
      return new Response('{}');
    };
    const onAction = vi.fn();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true, botToken });
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const post = (body: string, headers: Record<string, string> = {}) =>
      realFetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    return { bridge, post, onAction, handleWebhook, webhookUrl };
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    // Interaction acks go to the Discord API; keep them off the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  /** A Discord-shaped bridge: real thread-id encoding, editMessage capture, Discord's card limits. */
  async function startDiscord(questionId: string, render: Record<string, unknown>) {
    const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
    registerQuestionRenderResolver((id) => (id === questionId ? (render as never) : undefined));
    let webhookUrl = '';
    const editMessage = vi.fn(async () => ({ id: 'card-1', threadId: 't', raw: {} }));
    const handleWebhook = vi.fn(async () => new Response('ok'));
    const adapter = stubAdapter({
      name: 'discord',
      initialize: async () => {},
      handleWebhook,
      // As the Discord adapter: a thread id is the channel's plus ':<thread>'.
      channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 3).join(':'),
      encodeThreadId: ({ guildId, channelId, threadId }: { guildId: string; channelId: string; threadId?: string }) =>
        `discord:${guildId}:${channelId}${threadId ? `:${threadId}` : ''}`,
      editMessage,
    } as never) as Adapter & { startGatewayListener: unknown };
    adapter.startGatewayListener = async (_opts: unknown, _ms: number, _signal: AbortSignal, url: string) => {
      webhookUrl = url;
      return new Response('{}');
    };
    const texts = (card: CardElement) =>
      card.children.flatMap((child) => (child.type === 'text' ? [child.content] : []));
    // The host accepts the click unless a test says otherwise.
    const onAction = vi.fn().mockResolvedValue('accepted');
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: true,
      botToken: BOT_TOKEN,
      // Discord: embed title <= 256, description <= 4,096.
      cardFits: (card) => (card.title ?? '').length <= 256 && texts(card).join('\n\n').length <= 4096,
    });
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    /** Posts as the Gateway listener does: it sends a channel's next event only once this one is answered. */
    const forward = (event: Record<string, unknown>) =>
      realFetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-discord-gateway-token': BOT_TOKEN },
        body: JSON.stringify(event),
      });
    // Chat SDK 4.41+ encodes a button's custom_id as `${id}\n${value}`.
    const click = (
      user: Record<string, string>,
      customId = `ncq:${questionId}:0\n0`,
      extra: Record<string, unknown> = {},
    ) =>
      forward({
        type: 'GATEWAY_INTERACTION_CREATE',
        data: {
          type: 3,
          id: 'interaction-2',
          token: 'interaction-token',
          application_id: 'app-1',
          guild_id: 'G1',
          channel_id: 'C1',
          data: { custom_id: customId },
          member: { user },
          message: { id: 'card-1', embeds: [{ title: 'T'.repeat(256), description: 'Allow?' }] },
          ...extra,
        },
      });
    return { bridge, click, forward, onAction, editMessage, handleWebhook };
  }

  const CALLBACK = 'https://discord.com/api/v10/interactions/interaction-2/interaction-token/callback';
  const ORIGINAL = 'https://discord.com/api/v10/webhooks/app-1/interaction-token/messages/@original';
  const FOLLOW_UP = 'https://discord.com/api/v10/webhooks/app-1/interaction-token';
  const ACK = { type: 6 };
  const ackBodies = () =>
    vi.mocked(globalThis.fetch).mock.calls.map(([url, init]) => [String(url), JSON.parse(String(init?.body))]);
  const discordCalls = () =>
    vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([url, init]) => [init?.method, String(url), JSON.parse(String(init?.body))]);
  const review = {
    title: 'Review',
    question: 'Allow?',
    options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
  };

  it('acks a Discord click, then edits the card within Discord limits', async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord', {
      ...review,
      title: 'T'.repeat(300),
    });
    try {
      expect((await click({ id: 'clicker-1', username: 'clicker', global_name: 'Clicker' })).status).toBe(200);
      // Acked at once; the buttons go only once the host accepts the click (the embed is left for the edit below).
      await vi.waitFor(() =>
        expect(discordCalls()).toEqual([
          ['POST', CALLBACK, ACK],
          ['PATCH', ORIGINAL, { components: [] }],
        ]),
      );
      await vi.waitFor(() => expect(editMessage).toHaveBeenCalled());
      const [threadId, messageId, edited] = editMessage.mock.calls[0] as unknown as [
        string,
        string,
        { card: CardElement },
      ];
      expect([threadId, messageId]).toEqual(['discord:G1:C1', 'card-1']);
      expect(edited.card.title).toBe('Approval request');
      expect(edited.card.children.map((child) => (child as { content?: string }).content)).toEqual([
        'Allow?',
        'Approved by Clicker',
      ]);
      expect(onAction).toHaveBeenCalledWith('q-discord', 'approve', 'clicker-1', expect.anything());
    } finally {
      await bridge.teardown();
    }
  });

  it('decodes the selected option from the custom_id the adapter wrote, and the older plain form', async () => {
    const { bridge, click, onAction } = await startDiscord('q-discord-id', {
      ...review,
      options: [
        { label: 'Approve', selectedLabel: 'Approved', value: 'approve' },
        { label: 'Reject', selectedLabel: 'Rejected', value: 'reject' },
      ],
    });
    // Nothing decided, so the same card takes the second click too.
    onAction.mockResolvedValue('ignored');
    try {
      await click({ id: 'clicker-1', username: 'clicker' }, 'ncq:q-discord-id:1\n1');
      await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
      await click({ id: 'clicker-1', username: 'clicker' }, 'ncq:q-discord-id:0');
      await vi.waitFor(() => expect(onAction.mock.calls.map((call) => call[1])).toEqual(['reject', 'approve']));
    } finally {
      await bridge.teardown();
    }
  });

  it('records an option whose value is empty', async () => {
    const { bridge, click, onAction } = await startDiscord('q-discord-empty', {
      ...review,
      options: [{ label: 'No prefix', selectedLabel: 'No prefix', value: '' }],
    });
    try {
      await click({ id: 'clicker-1', username: 'clicker' }, 'ncq:q-discord-empty:0\n0');
      await vi.waitFor(() =>
        expect(onAction).toHaveBeenCalledWith('q-discord-empty', '', 'clicker-1', expect.anything()),
      );
    } finally {
      await bridge.teardown();
    }
  });

  it('acks within the time limit, then removes the buttons only after the host accepts the click', async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-order', review);
    const order: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      order.push(init?.method === 'PATCH' ? 'buttons removed' : 'acked');
      return new Response(null, { status: 204 });
    });
    let accept!: () => void;
    onAction.mockImplementation(() => {
      order.push('decision dispatched');
      return new Promise((resolve) => (accept = () => resolve('accepted')));
    });
    editMessage.mockImplementation(async () => {
      order.push('card edited');
      return { id: 'card-1', threadId: 't', raw: {} };
    });
    try {
      expect((await click({ id: 'clicker-1', username: 'clicker' })).status).toBe(200);
      // The host has not answered yet: acked, buttons still there.
      await vi.waitFor(() => expect(order).toEqual(['acked', 'decision dispatched']));
      accept();
      await vi.waitFor(() => expect(order).toEqual(['acked', 'decision dispatched', 'buttons removed', 'card edited']));
    } finally {
      await bridge.teardown();
    }
  });

  it('edits the card text even when the button removal stalls', async () => {
    const { bridge, click, editMessage } = await startDiscord('q-discord-stalled-patch', review);
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) =>
      init?.method === 'PATCH' ? new Promise<Response>(() => {}) : new Response(null, { status: 204 }),
    );
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() => expect(editMessage).toHaveBeenCalledTimes(1));
    } finally {
      await bridge.teardown();
    }
  });

  it('keeps the buttons and answers only the clicker when a non-approver clicks', async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-refused', review);
    onAction.mockResolvedValue('refused');
    try {
      expect((await click({ id: 'bystander', username: 'Bob' })).status).toBe(200);
      await vi.waitFor(() =>
        expect(discordCalls()).toEqual([
          ['POST', CALLBACK, ACK],
          // flags 64: only the clicker sees it.
          ['POST', FOLLOW_UP, { content: 'Only an approver can answer this.', flags: 64 }],
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(editMessage).not.toHaveBeenCalled();
      expect(discordCalls()).toHaveLength(2);
    } finally {
      await bridge.teardown();
    }
  });

  it('addresses a click in a thread by its parent channel and the thread, as the adapter does', async () => {
    const { bridge, click, onAction } = await startDiscord('q-discord-thread', review);
    try {
      await click({ id: 'clicker-1', username: 'Ann' }, undefined, {
        channel_id: 'T1',
        channel: { id: 'T1', type: 11, parent_id: 'P1' },
      });
      await vi.waitFor(() =>
        expect(onAction).toHaveBeenCalledWith('q-discord-thread', 'approve', 'clicker-1', {
          messageId: 'card-1',
          platformId: 'discord:G1:P1',
          threadId: 'discord:G1:P1:T1',
        }),
      );
    } finally {
      await bridge.teardown();
    }
  });

  it('a click the host ignores (a second click) leaves the card as it is', async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-second', review);
    onAction.mockResolvedValue('ignored');
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(discordCalls()).toEqual([['POST', CALLBACK, ACK]]);
      expect(editMessage).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('a second click on a Discord card reaches the host after the first; an ignored one changes nothing', async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-answered', review);
    onAction.mockResolvedValueOnce('accepted').mockResolvedValueOnce('ignored');
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() => expect(editMessage).toHaveBeenCalledTimes(1));
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(editMessage).toHaveBeenCalledTimes(1);
      expect(discordCalls().map(([method, url]) => `${method} ${url}`)).toEqual([
        `POST ${CALLBACK}`,
        `PATCH ${ORIGINAL}`,
        `POST ${CALLBACK}`,
      ]);
    } finally {
      await bridge.teardown();
    }
  });

  it("Discord: a render's afterClick note goes privately (flags 64) and its card is drawn", async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-after', {
      ...review,
      afterClick: async () => ({ card: { markdown: 'Only Cy decides' }, privateNote: 'Only Cy can approve this.' }),
    });
    onAction.mockResolvedValue('refused');
    try {
      await click({ id: 'bystander', username: 'Bob' });
      await vi.waitFor(() =>
        expect(editMessage).toHaveBeenCalledWith('discord:G1:C1', 'card-1', { markdown: 'Only Cy decides' }),
      );
      expect(discordCalls()).toContainEqual(['POST', FOLLOW_UP, { content: 'Only Cy can approve this.', flags: 64 }]);
      // The returned card is drawn as returned: no separate button removal.
      expect(discordCalls().filter(([method]) => method === 'PATCH')).toEqual([]);
    } finally {
      await bridge.teardown();
    }
  });

  it('Discord: says a closed request is no longer available', async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-closed', review);
    onAction.mockResolvedValue('closed');
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() => expect(editMessage).toHaveBeenCalledTimes(1));
      expect(JSON.stringify(editMessage.mock.calls[0])).toContain('No longer available');
    } finally {
      await bridge.teardown();
    }
  });

  it('answers a refused click on a gateway (deferred) card privately too', async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-gw-refused', {
      ...review,
      deferResolution: true,
    });
    onAction.mockResolvedValue('refused');
    try {
      await click({ id: 'bystander', username: 'Bob' });
      await vi.waitFor(() =>
        expect(discordCalls()).toEqual([
          ['POST', CALLBACK, ACK],
          ['POST', FOLLOW_UP, { content: 'Only an approver can answer this.', flags: 64 }],
        ]),
      );
      expect(editMessage).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('leaves an already resolved Discord card alone when a late click arrives', async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-other', review);
    try {
      expect((await click({ id: 'clicker-1', username: 'Ann' }, 'ncq:q-discord-resolved:0\n0')).status).toBe(200);
      expect(ackBodies()).toEqual([[CALLBACK, { type: 6 }]]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(editMessage).not.toHaveBeenCalled();
      expect(onAction).toHaveBeenCalledWith('q-discord-resolved', '0', 'clicker-1', expect.anything());
    } finally {
      await bridge.teardown();
    }
  });

  it('still dispatches a click when the Discord ack fails', async () => {
    const { bridge, click, onAction } = await startDiscord('q-discord-ackfail', review);
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('ECONNRESET'));
    try {
      // One with stored render metadata, one without (a migrated pending row): both reach the host.
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
      await click({ id: 'clicker-1', username: 'Ann' }, 'ncq:q-discord-no-render:0\n0');
      await vi.waitFor(() =>
        expect(onAction.mock.calls.map((call) => call[0])).toEqual(['q-discord-ackfail', 'q-discord-no-render']),
      );
    } finally {
      await bridge.teardown();
    }
  });

  it('still dispatches a gateway (deferred) click when the Discord ack fails', async () => {
    const { bridge, click, onAction } = await startDiscord('q-discord-deferred', { ...review, deferResolution: true });
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('ECONNRESET'));
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() =>
        expect(onAction).toHaveBeenCalledWith('q-discord-deferred', 'approve', 'clicker-1', expect.anything()),
      );
    } finally {
      await bridge.teardown();
    }
  });

  it('a stalled Discord ack holds neither the click nor the next event in its channel', async () => {
    const { bridge, click, forward, onAction, handleWebhook } = await startDiscord('q-discord-ack-stall', review);
    const deadlines = controlDeadlines();
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) =>
      String(url) === CALLBACK ? stalled(url, init) : new Response(null, { status: 204 }),
    );
    try {
      expect((await click({ id: 'clicker-1', username: 'Ann' })).status).toBe(200);
      await vi.waitFor(() =>
        expect(onAction).toHaveBeenCalledWith('q-discord-ack-stall', 'approve', 'clicker-1', expect.anything()),
      );
      expect((await forward({ type: 'GATEWAY_MESSAGE_CREATE', data: { id: 'm-2', channel_id: 'C1' } })).status).toBe(
        200,
      );
      expect(handleWebhook).toHaveBeenCalledTimes(1);
      // Still bounded: the stalled ack ends at its own deadline.
      expect(deadlines.asked).toEqual([10_000]);
    } finally {
      deadlines.restore();
      await bridge.teardown();
    }
  });

  it('ends a stalled Discord ack at its deadline, then still answers the clicker', async () => {
    const { bridge, click, onAction } = await startDiscord('q-discord-ack-deadline', review);
    onAction.mockResolvedValue('refused');
    const deadlines = controlDeadlines();
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) =>
      String(url) === CALLBACK ? stalled(url, init) : new Response(null, { status: 204 }),
    );
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      await click({ id: 'bystander', username: 'Bob' });
      await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
      // The private note goes through the interaction's webhook, which needs the ack first.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(discordCalls()).toEqual([['POST', CALLBACK, ACK]]);
      expect(deadlines.asked).toEqual([10_000]);

      deadlines.expire();
      await vi.waitFor(() =>
        expect(discordCalls()).toEqual([
          ['POST', CALLBACK, ACK],
          ['POST', FOLLOW_UP, { content: 'Only an approver can answer this.', flags: 64 }],
        ]),
      );
      expect(deadlines.asked).toEqual([10_000, 10_000]);
      expect(errors).toHaveBeenCalledWith('Failed to acknowledge interaction', expect.anything());
    } finally {
      errors.mockRestore();
      deadlines.restore();
      await bridge.teardown();
    }
  });

  it('ends a stalled Discord webhook call at its deadline, so the next click on the card goes ahead', async () => {
    const { bridge, click, onAction } = await startDiscord('q-discord-webhook-deadline', review);
    onAction.mockResolvedValue('refused');
    const deadlines = controlDeadlines();
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) =>
      String(url) === FOLLOW_UP ? stalled(url, init) : new Response(null, { status: 204 }),
    );
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      await click({ id: 'bystander', username: 'Bob' });
      await vi.waitFor(() => expect(discordCalls().map(([, url]) => url)).toEqual([CALLBACK, FOLLOW_UP]));
      // Clicks on one card run one at a time: the second waits on the first one's stalled note.
      await click({ id: 'bystander', username: 'Bob' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onAction).toHaveBeenCalledTimes(1);

      deadlines.expire();
      await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));
      // The first click's ack and note, and the second click's ack.
      expect(deadlines.asked.slice(0, 3)).toEqual([10_000, 10_000, 10_000]);
      expect(errors).toHaveBeenCalledWith('Discord interaction webhook failed', expect.anything());
    } finally {
      errors.mockRestore();
      deadlines.restore();
      await bridge.teardown();
    }
  });

  it('records the decision when the card edit fails or hangs', async () => {
    for (const [questionId, outcome] of [
      ['q-discord-fail', Promise.reject(new Error('Discord 400'))],
      ['q-discord-hang', new Promise(() => {})],
    ] as const) {
      outcome.catch(() => {});
      const { bridge, click, onAction, editMessage } = await startDiscord(questionId, review);
      editMessage.mockReturnValueOnce(outcome as never);
      try {
        expect((await click({ id: 'clicker-1', username: 'clicker' })).status).toBe(200);
        await vi.waitFor(() =>
          expect(onAction).toHaveBeenCalledWith(questionId, 'approve', 'clicker-1', expect.anything()),
        );
        expect(ackBodies()[0]).toEqual([CALLBACK, ACK]);
      } finally {
        await bridge.teardown();
      }
    }
  });

  it('keeps who decided when a selected label is longer than one text block', async () => {
    const { bridge, click, editMessage } = await startDiscord('q-discord-label', {
      title: 'Review',
      question: 'Allow?',
      options: [{ label: 'Approve', selectedLabel: 'L'.repeat(2100), value: 'approve' }],
    });
    try {
      await click({ id: 'clicker-1', username: 'clicker', global_name: 'Clicker' });
      await vi.waitFor(() => expect(editMessage).toHaveBeenCalled());
      const edited = (editMessage.mock.calls[0] as unknown as [string, string, { card: CardElement }])[2];
      const resolution = (edited.card.children.at(-1) as { content: string }).content;
      expect(resolution.endsWith('… by Clicker')).toBe(true);
      expect(resolution.length).toBeLessThanOrEqual(CARD_TEXT_BLOCK_LENGTH);
    } finally {
      await bridge.teardown();
    }
  });

  it.each([
    ['no gateway token', {}],
    ['a wrong gateway token', { 'x-discord-gateway-token': 'not-the-token' }],
  ])('rejects a request with %s before it reaches the adapter or the host', async (_label, headers) => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(BOT_TOKEN);
    try {
      for (const body of [click, message]) {
        const res = await post(body, headers);
        expect(res.status).toBe(401);
      }
      expect(onAction).not.toHaveBeenCalled();
      expect(handleWebhook).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('answers 401 without waiting for the request body', async () => {
    const { bridge, webhookUrl } = await startGateway(BOT_TOKEN);
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.request(webhookUrl, { method: 'POST', headers: { 'Content-Length': '1000' } }, (res) => {
          resolve(res.statusCode);
          req.destroy();
        });
        req.on('error', reject);
        req.flushHeaders(); // the body never follows
      });
      expect(status).toBe(401);
    } finally {
      await bridge.teardown();
    }
  });

  it('rejects every request when no bot token is configured', async () => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(undefined);
    try {
      const res = await post(click, { 'x-discord-gateway-token': '' });
      expect(res.status).toBe(401);
      expect((await post(message)).status).toBe(401);
      expect(onAction).not.toHaveBeenCalled();
      expect(handleWebhook).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('dispatches clicks and forwards other events when the gateway token matches', async () => {
    const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
    // A pending question has a render; one without is already resolved and left alone.
    registerQuestionRenderResolver((id) =>
      id === 'q-1'
        ? { title: 'Review', options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }] }
        : undefined,
    );
    const { bridge, post, onAction, handleWebhook } = await startGateway(BOT_TOKEN);
    try {
      const auth = { 'x-discord-gateway-token': BOT_TOKEN };
      expect((await post(click, auth)).status).toBe(200);
      await vi.waitFor(() =>
        // The encoded channel, as the card's messaging group records it (not the raw Discord id).
        expect(onAction).toHaveBeenCalledWith('q-1', 'approve', 'clicker-1', {
          messageId: 'card-1',
          platformId: 'discord:@me:chan-1',
          threadId: 'discord:@me:chan-1',
        }),
      );
      expect((await post(message, auth)).status).toBe(200);
      expect(handleWebhook).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
    }
  });

  it('decodes the option index when @chat-adapter/discord appends "\\n<value>" to custom_id', async () => {
    const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
    registerQuestionRenderResolver((id) =>
      id === 'q-index'
        ? {
            title: 'Install Packages Request',
            options: [
              { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
              { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
            ],
          }
        : undefined,
    );
    const encodedClick = JSON.stringify({
      type: 'GATEWAY_INTERACTION_CREATE',
      data: {
        type: 3,
        id: 'interaction-2',
        token: 'interaction-token',
        channel_id: 'chan-1',
        // Button({ id: 'ncq:q-index:0', value: '0' }) as encoded by the Discord adapter.
        data: { custom_id: 'ncq:q-index:0\n0' },
        member: { user: { id: 'clicker-1', username: 'clicker' } },
        message: { id: 'card-2', embeds: [] },
      },
    });
    const { bridge, post, onAction } = await startGateway(BOT_TOKEN);
    try {
      expect((await post(encodedClick, { 'x-discord-gateway-token': BOT_TOKEN })).status).toBe(200);
      await vi.waitFor(() =>
        expect(onAction).toHaveBeenCalledWith('q-index', 'approve', 'clicker-1', {
          messageId: 'card-2',
          platformId: 'discord:@me:chan-1',
          threadId: 'discord:@me:chan-1',
        }),
      );
    } finally {
      await bridge.teardown();
    }
  });

  /** A Discord call that never answers: it ends only when its signal aborts. */
  const stalled = (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
  /**
   * Hands out the bridge's Discord deadlines as signals the test fires, so a
   * stall ends at once instead of after 10 s. `asked` is what each call wanted.
   */
  function controlDeadlines() {
    const asked: number[] = [];
    const pending: AbortController[] = [];
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      asked.push(ms);
      const controller = new AbortController();
      pending.push(controller);
      return controller.signal;
    });
    const expire = () => {
      for (const controller of pending.splice(0)) {
        controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      }
    };
    const restore = () => {
      expire();
      spy.mockRestore();
    };
    return { asked, expire, restore };
  }

  it('ends a stalled Discord ack at its deadline, and the click still reaches the host', async () => {
    const { bridge, click, onAction } = await startDiscord('q-discord-ack-deadline', review);
    const deadlines = controlDeadlines();
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) =>
      String(url).endsWith('/callback') ? stalled(url, init) : new Response(null, { status: 204 }),
    );
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      const answered = click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() => expect(deadlines.asked).toEqual([10_000]));
      deadlines.expire();
      expect((await answered).status).toBe(200);
      await vi.waitFor(() =>
        expect(onAction).toHaveBeenCalledWith('q-discord-ack-deadline', 'approve', 'clicker-1', expect.anything()),
      );
      expect(errors).toHaveBeenCalledWith('Failed to acknowledge interaction', expect.anything());
    } finally {
      errors.mockRestore();
      deadlines.restore();
      await bridge.teardown();
    }
  });
});
