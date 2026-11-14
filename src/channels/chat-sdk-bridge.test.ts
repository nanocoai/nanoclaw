import http from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Actions,
  Card,
  CardText,
  Chart,
  Divider,
  Field,
  Fields,
  LinkButton,
  Table,
  type Adapter,
  type AdapterPostableMessage,
  type CardElement,
  type RawMessage,
} from 'chat';

import { fenceForCard } from '../card-text.js';
import { gatewayApprovalPresentation } from '../gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from '../gateway-providers/gateway-provider-registry.js';
import { log } from '../log.js';
import { CardTooLongError } from './ask-question.js';
import {
  attachmentBytesToBase64,
  CARD_EDIT_SETTLE_MS,
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

/** A click handler returns once the host has the click. This lets what follows it (card edit, private note) finish. */
const afterClick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

  it('never hard-cuts through a surrogate pair', () => {
    // The leading 'a' puts a cut at 30 between an emoji's two halves.
    const text = 'a' + '😀'.repeat(50);
    const chunks = splitForLimit(text, 30);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(30);
      // Slack's client form-encodes the text; a lone half throws "URI malformed".
      expect(() => encodeURIComponent(c)).not.toThrow();
    }
    expect(chunks.join('')).toBe(text);
  });

  it('still ends when the limit is too short to hold one emoji', () => {
    // Only the end is promised: a 1-character part can't hold an emoji whole.
    // The smallest limit any channel sets is 2,000.
    expect(splitForLimit('😀😀', 1).join('')).toBe('😀😀');
  });

  it('delivers a long emoji reply as parts that each encode', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      maxTextLength: 30,
    });
    const text = 'a' + '😀'.repeat(50);
    await bridge.deliver('slack:C1', null, { kind: 'chat-sdk', content: { text } });

    const parts = calls.map((call) => (call.message as { markdown: string }).markdown);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(() => encodeURIComponent(part)).not.toThrow();
    expect(parts.join('')).toBe(text);
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

  it("refuses a card over the channel's declared limit, counting the title, posting nothing", async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      maxCardTextLength: 100,
    });

    const fits = 'x'.repeat(100 - CARD_TITLE.length);
    await expect(bridge.deliver('slack:D1', null, questionCard(`${fits}x`))).rejects.toThrow(CardTooLongError);
    expect(calls).toHaveLength(0);
    await bridge.deliver('slack:D1', null, questionCard(fits));
    expect(calls).toHaveLength(1);
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
    await expect(bridge.deliver('slack:D1', null, questionCard(question, 'OK'))).rejects.toThrow(CardTooLongError);
    expect(calls).toHaveLength(0);
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
      maxCardTextLength: 100,
    });

    await expect(bridge.deliver('slack:D1', null, questionCard('&'.repeat(20)))).rejects.toThrow(/limit 100/);
    expect(calls).toHaveLength(0);
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
    expect(splitCardText('x'.repeat(48) + '```\ncode\n```', (t) => t, 50)).toEqual(['x'.repeat(48), '```\ncode\n```']);
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

describe('createChatSdkBridge.deliver — send_card card parts', () => {
  const postedCard = (call: PostCall) => (call.message as { card: { children: unknown[] } }).card;
  const deliverCard = async (card: Record<string, unknown>) => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({ adapter: stubAdapter({ postMessage }), supportsThreads: false });
    const delivery = bridge.deliver('slack:C1', null, { kind: 'chat-sdk', content: { type: 'card', card } });
    return { calls, delivery };
  };
  const table = { type: 'Table', props: { headers: ['Scale', 'Before'], rows: [['1x', 40]] } };
  const bar = {
    type: 'Chart',
    props: { title: 'Latency', chart: { type: 'bar', categories: ['1x'], series: [{ name: 'Before', values: [40] }] } },
  };

  // The card Slack and Teams received in the live run: a change to how parts are built must keep it.
  it('posts exactly the card the Chat SDK builders make for the parts', async () => {
    const { calls, delivery } = await deliverCard({
      title: 'Perf review',
      children: [
        'Before/after the cache change.',
        {
          type: 'Fields',
          children: [
            { type: 'Field', props: { label: 'p95', value: '118 ms' } },
            { type: 'Field', props: { label: 'Errors', value: 0.2 } },
          ],
        },
        {
          type: 'Table',
          props: {
            headers: ['Load', 'Before (ms)'],
            rows: [
              ['1x', 40],
              ['20x', 990],
            ],
            align: ['left', 'right'],
            caption: 'Latency before vs after',
          },
        },
        {
          type: 'Chart',
          props: {
            title: 'Latency (ms)',
            chart: {
              type: 'bar',
              categories: ['1x', '20x'],
              series: [{ name: 'Before', values: [40, 990] }],
              xLabel: 'Load',
              yLabel: 'ms',
            },
          },
        },
        {
          type: 'Chart',
          props: { title: 'Where time goes', chart: { type: 'pie', segments: [{ label: 'Render', value: 55 }] } },
        },
        { type: 'Divider' },
        { type: 'Text', props: { content: 'Measured on staging.', style: 'muted' } },
      ],
      actions: [{ label: 'Open report', url: 'https://example.com/report' }],
    });
    await delivery;

    expect(JSON.parse(JSON.stringify(postedCard(calls[0])))).toEqual(
      JSON.parse(
        JSON.stringify(
          Card({
            title: 'Perf review',
            children: [
              CardText('Before/after the cache change.'),
              Fields([Field({ label: 'p95', value: '118 ms' }), Field({ label: 'Errors', value: '0.2' })]),
              Table({
                headers: ['Load', 'Before (ms)'],
                rows: [
                  ['1x', '40'],
                  ['20x', '990'],
                ],
                align: ['left', 'right'],
                caption: 'Latency before vs after',
              }),
              Chart({
                title: 'Latency (ms)',
                chart: {
                  type: 'bar',
                  categories: ['1x', '20x'],
                  xLabel: 'Load',
                  yLabel: 'ms',
                  series: [
                    {
                      name: 'Before',
                      data: [
                        { label: '1x', value: 40 },
                        { label: '20x', value: 990 },
                      ],
                    },
                  ],
                },
              }),
              Chart({ title: 'Where time goes', chart: { type: 'pie', segments: [{ label: 'Render', value: 55 }] } }),
              Divider(),
              CardText('Measured on staging.', { style: 'muted' }),
              Actions([LinkButton({ label: 'Open report', url: 'https://example.com/report' })]),
            ],
          }),
        ),
      ),
    );
  });

  it('builds each part as its Chat SDK element, in place among the text children', async () => {
    const { calls, delivery } = await deliverCard({
      title: 'Perf',
      children: [
        'intro',
        { type: 'Fields', children: [{ type: 'Field', props: { label: 'p50', value: 42 } }] },
        table,
        bar,
        { type: 'Divider' },
        { type: 'Text', props: { content: 'footnote', style: 'muted' } },
        'outro',
      ],
    });
    await delivery;

    const children = postedCard(calls[0]).children as Array<Record<string, unknown>>;
    expect(children.map((c) => c.type)).toEqual(['text', 'fields', 'table', 'chart', 'divider', 'text', 'text']);
    expect(children[1]).toEqual({ type: 'fields', children: [{ type: 'field', label: 'p50', value: '42' }] });
    expect(children[2]).toMatchObject({ headers: ['Scale', 'Before'], rows: [['1x', '40']] });
    expect(children[3]).toMatchObject({
      title: 'Latency',
      chart: { type: 'bar', categories: ['1x'], series: [{ name: 'Before', data: [{ label: '1x', value: 40 }] }] },
    });
    expect(children[6]).toEqual({ type: 'text', content: 'outro', style: undefined });
  });

  it.each([
    ['a callback button', { type: 'Button', props: { id: 'ncq:q-1:0', label: 'Approve' } }],
    ['an actions row', { type: 'Actions', children: [{ type: 'Button', props: { id: 'ncq:q-1:0', label: 'x' } }] }],
    ['an image', { type: 'Image', props: { url: 'https://example.com/a.png', alt: 'x' } }],
    ['a nested card', { type: 'Card', props: { title: 'Approve?' } }],
    [
      'a button inside Fields',
      { type: 'Fields', children: [{ type: 'Button', props: { id: 'ncq:q-1:0', label: 'x' } }] },
    ],
    ['a malformed table', { type: 'Table', props: { headers: ['a', 'b'], rows: [['1']] } }],
    ['a field named after an object method', { type: 'Fields', children: [{ type: 'constructor' }] }],
    ['a table too long for Slack to draw', { type: 'Table', props: { headers: ['a'], rows: [['x'.repeat(10_000)]] } }],
    [
      'a too-long table given as object rows',
      { type: 'Table', props: { headers: ['a'], rows: [{ a: 'x'.repeat(10_000) }] } },
    ],
    [
      'a too-long table given as template cells',
      { type: 'Table', props: { headers: ['a'], rows: [[{ $template: 'x'.repeat(10_000) }]] } },
    ],
  ])('refuses a card with %s instead of posting it', async (_, part) => {
    const { calls, delivery } = await deliverCard({ title: 'Perf', children: ['intro', part] });

    await expect(delivery).rejects.toThrow(/send_card card refused: children\[1\]/);
    expect(calls).toHaveLength(0);
  });

  const field = (label: string) => ({ type: 'Field', props: { label, value: '1' } });
  const lineChart = (chart: Record<string, unknown>, title = 'Latency') => ({
    type: 'Chart',
    props: { title, chart: { type: 'line', ...chart } },
  });
  it.each([
    ['11 parts', Array.from({ length: 11 }, () => ({ type: 'Divider' })), /at most 10 parts per card/],
    [
      '11 fields across two Fields parts',
      [
        { type: 'Fields', children: Array.from({ length: 6 }, (_, i) => field(`f${i}`)) },
        { type: 'Fields', children: Array.from({ length: 5 }, (_, i) => field(`g${i}`)) },
      ],
      /at most 10 fields per card/,
    ],
    [
      'a text part over 2,500 characters',
      [{ type: 'Text', props: { content: 'x'.repeat(2_501) } }],
      /at most 2500 characters/,
    ],
    [
      'a field over 1,500 characters',
      [{ type: 'Fields', children: [{ type: 'Field', props: { label: 'a', value: 'x'.repeat(1_500) } }] }],
      /at most 1500/,
    ],
    [
      'a chart value of Infinity, as JSON reads 1e400',
      [lineChart({ categories: ['a'], series: [{ name: 'b', values: [Infinity] }] })],
      /values must be numbers/,
    ],
    [
      'a table with no text',
      [{ type: 'Table', props: { headers: [' '], rows: [] } }],
      /the table has no text in its headers or cells/,
    ],
    [
      'a table of 31 rows',
      [{ type: 'Table', props: { headers: ['a'], rows: Array.from({ length: 31 }, () => ['1']) } }],
      /at most 30 rows/,
    ],
    [
      'a pie with a repeated slice label',
      [
        {
          type: 'Chart',
          props: {
            title: 'P',
            chart: {
              type: 'pie',
              segments: [
                { label: 'a', value: 1 },
                { label: 'a', value: 2 },
              ],
            },
          },
        },
      ],
      /must not repeat/,
    ],
    [
      'a table of 7 columns',
      [{ type: 'Table', props: { headers: ['1', '2', '3', '4', '5', '6', '7'], rows: [] } }],
      /at most 6 columns/,
    ],
    [
      'a table whose caption makes it too long',
      [{ type: 'Table', props: { headers: ['a'], rows: [], caption: 'x'.repeat(10_000) } }],
      /at most 10000/,
    ],
    [
      'a chart title over 50 characters',
      [lineChart({ categories: ['a'], series: [{ name: 'b', values: [1] }] }, 'x'.repeat(51))],
      /props\.title/,
    ],
    [
      'a chart label over 20 characters',
      [lineChart({ categories: ['x'.repeat(21)], series: [{ name: 'b', values: [1] }] })],
      /at most 20 characters/,
    ],
    [
      'an axis label over 50 characters',
      [lineChart({ categories: ['a'], series: [{ name: 'b', values: [1] }], yLabel: 'x'.repeat(51) })],
      /axis labels/,
    ],
    [
      '21 categories',
      [
        lineChart({
          categories: Array.from({ length: 21 }, (_, i) => `${i}`),
          series: [{ name: 'b', values: Array.from({ length: 21 }, () => 1) }],
        }),
      ],
      /1 to 20 categories/,
    ],
    [
      '13 series',
      [
        lineChart({
          categories: ['a'],
          series: Array.from({ length: 13 }, (_, i) => ({ name: `s${i}`, values: [1] })),
        }),
      ],
      /1 to 12 series/,
    ],
    [
      'a repeated category',
      [lineChart({ categories: ['a', 'a'], series: [{ name: 'b', values: [1, 2] }] })],
      /must not repeat/,
    ],
    [
      'over 12,000 characters across parts',
      Array.from({ length: 5 }, () => ({ type: 'Text', props: { content: 'x'.repeat(2_500) } })),
      /at most 12000 per card/,
    ],
  ])('refuses a card with %s and posts nothing', async (_, children, reason) => {
    const { calls, delivery } = await deliverCard({ title: 'Perf', children });

    await expect(delivery).rejects.toThrow(reason);
    expect(calls).toHaveLength(0);
  });

  it('checks a card with no children against the card budget and posts nothing', async () => {
    const { calls, delivery } = await deliverCard({ title: 'Perf', description: 'x'.repeat(12_001) });

    await expect(delivery).rejects.toThrow(/at most 12000 per card/);
    expect(calls).toHaveLength(0);
  });

  it('posts a part with only the fields it may have, so a stray key such as an ncq: id never goes out', async () => {
    const { calls, delivery } = await deliverCard({
      children: [
        { type: 'Table', id: 'ncq:q-1:0', props: { headers: ['a'], rows: [['1']], actions: [{ id: 'ncq:q-1:0' }] } },
      ],
    });
    await delivery;

    expect(JSON.stringify(postedCard(calls[0]))).not.toContain('ncq:');
  });

  it('refuses a card over the per-card limits the tool enforces, whoever wrote the row', async () => {
    const tables = await deliverCard({ children: [table, table] });
    const charts = await deliverCard({ children: [bar, bar, bar] });

    await expect(tables.delivery).rejects.toThrow(/at most 1 Table/);
    await expect(charts.delivery).rejects.toThrow(/at most 2 Chart/);
    expect([...tables.calls, ...charts.calls]).toHaveLength(0);
  });

  it('renders an old-style text card exactly as before', async () => {
    const { calls, delivery } = await deliverCard({
      title: 'Daily',
      description: 'Your plate today',
      children: ['• item one', { text: '• item two' }, { type: 'text', text: '• item three' }, '', 42],
    });
    await delivery;

    expect(postedCard(calls[0])).toEqual(
      Card({
        title: 'Daily',
        children: [
          CardText('Your plate today'),
          CardText('• item one'),
          CardText('• item two'),
          CardText('• item three'),
        ],
      }),
    );
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
    await afterClick();
    expect(onAction).toHaveBeenCalledWith('address-fixture', 'approve', 'selected', {
      instance: 'fixture-one',
      messageId: 'original-card',
      platformId: 'fixture:room',
    });
    expect(editMessage).not.toHaveBeenCalled();
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
    await afterClick();
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
    await afterClick();
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
    /** The click handler alone: done when the handler returns. */
    const handle = (userId: string, userName: string) =>
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
    const click = async (userId: string, userName: string) => {
      await handle(userId, userName);
      await afterClick();
    };
    return { bridge, click, handle, onAction, editMessage, postEphemeral, order };
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

  // Some transports (Telegram's polling) read their next events only once the
  // handler returns, so one slow decision must not keep it.
  it('hands a click to the host and returns before the host has decided', async () => {
    const { bridge, handle, onAction, editMessage } = await startClicks('q-slow-host', review);
    let decide!: (outcome: string) => void;
    onAction.mockReturnValue(new Promise((resolve) => (decide = resolve)));
    try {
      // The handler is done, and the host already has the click.
      await handle('approver', 'Ann');
      expect(onAction).toHaveBeenCalledTimes(1);
      await afterClick();
      expect(editMessage).not.toHaveBeenCalled();
      decide('accepted');
      await vi.waitFor(() => expect(editMessage).toHaveBeenCalledTimes(1));
      expect(JSON.stringify(editMessage.mock.calls[0])).toContain('✅ Approved by Ann');
    } finally {
      await bridge.teardown();
    }
  });

  it('hands clicks that come one after another to the host in that order, each shown when it is decided', async () => {
    const { bridge, handle, onAction, editMessage, postEphemeral } = await startClicks('q-two-clicks', review);
    let decideFirst!: (outcome: string) => void;
    onAction.mockReturnValueOnce(new Promise((resolve) => (decideFirst = resolve))).mockResolvedValueOnce('accepted');
    try {
      // The host has each click by the time its handler returns.
      await handle('bystander', 'Bob');
      expect(onAction.mock.calls.map((call) => call[2])).toEqual(['bystander']);
      await handle('approver', 'Ann');
      expect(onAction.mock.calls.map((call) => call[2])).toEqual(['bystander', 'approver']);
      await afterClick();
      // The second click is shown while the first is still with the host.
      expect(JSON.stringify(editMessage.mock.calls)).toContain('✅ Approved by Ann');
      expect(postEphemeral).not.toHaveBeenCalled();
      decideFirst('refused');
      await vi.waitFor(() => expect(postEphemeral).toHaveBeenCalledTimes(1));
      expect(editMessage).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
    }
  });

  it('logs a click the host fails on, and leaves the card as it is', async () => {
    const { bridge, click, onAction, editMessage } = await startClicks('q-host-fails', review);
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    onAction.mockRejectedValue(new Error('host down'));
    try {
      await click('approver', 'Ann');
      expect(errors).toHaveBeenCalledWith('Failed to handle a card click', { err: expect.any(Error) });
      expect(editMessage).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await bridge.teardown();
    }
  });

  // A channel refuses a redraw past its size limit: a card near that limit grew by its decision line.
  it('redraws a card with its title and decision only when the channel refuses the whole card', async () => {
    const { bridge, click, onAction, editMessage } = await startClicks('q-too-long', review);
    onAction.mockResolvedValue('accepted');
    editMessage.mockRejectedValueOnce(new CardTooLongError('embed description is over 4096'));
    try {
      await click('approver', 'Ann');
      await vi.waitFor(() => expect(editMessage).toHaveBeenCalledTimes(2));
      const [whole, short] = editMessage.mock.calls.map((call) => JSON.stringify((call as unknown[])[2]));
      expect(whole).toContain('Allow?');
      expect(short).not.toContain('Allow?');
      expect(short).toContain('Review');
      expect(short).toContain('✅ Approved by Ann');
    } finally {
      await bridge.teardown();
    }
  });

  it.each(['HTTP 500', 'response lost after edit'])(
    'preserves request text on a transient edit failure: %s',
    async (reason) => {
      const { bridge, click, onAction, editMessage } = await startClicks('q-retry-full', review);
      onAction.mockResolvedValue('accepted');
      editMessage.mockRejectedValueOnce(new Error(reason));
      try {
        await click('approver', 'Ann');
        await vi.waitFor(() => expect(editMessage).toHaveBeenCalledTimes(2));
        expect(editMessage.mock.calls[1]).toEqual(editMessage.mock.calls[0]);
        expect(JSON.stringify(editMessage.mock.calls[1])).toContain('Allow?');
        expect(JSON.stringify(editMessage.mock.calls[1])).toContain('✅ Approved by Ann');
      } finally {
        await bridge.teardown();
      }
    },
  );

  it('tries no shorter card when the refused card had no question to drop', async () => {
    const { bridge, click, onAction, editMessage } = await startClicks('q-no-question', {
      title: 'Review',
      options: review.options,
    });
    onAction.mockResolvedValue('accepted');
    editMessage.mockRejectedValue(new Error('platform down'));
    try {
      await click('approver', 'Ann');
      expect(editMessage).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
    }
  });

  it('redraws a card the host resolves with its decision only when the channel refuses the whole card', async () => {
    const { bridge, editMessage } = await startClicks('q-host-redraw', review);
    const redraw = () =>
      bridge.deliver('fixture:room', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'card-1',
          terminalCard: { title: 'Review', question: 'Allow?', resolution: '⏱️ Timed out' },
        },
      });
    try {
      editMessage.mockRejectedValueOnce(new CardTooLongError('embed description is over 4096'));
      await redraw();
      expect(editMessage).toHaveBeenCalledTimes(2);
      const short = JSON.stringify((editMessage.mock.calls[1] as unknown[])[2]);
      expect(short).not.toContain('Allow?');
      expect(short).toContain('⏱️ Timed out');
      // Refused both times: the host hears it, as before.
      editMessage.mockRejectedValue(new Error('platform down'));
      await expect(redraw()).rejects.toThrow('platform down');
    } finally {
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

  /** A Discord-shaped bridge: real thread-id encoding and editMessage capture. */
  async function startDiscord(questionId: string, render: Record<string, unknown>) {
    const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
    registerQuestionRenderResolver((id) => (id === questionId ? (render as never) : undefined));
    let webhookUrl = '';
    const editMessage = vi.fn(async () => ({ id: 'card-1', threadId: 't', raw: {} }));
    const postMessage = vi.fn(async (threadId: string, _message: AdapterPostableMessage) => ({
      id: 'card-1',
      threadId,
      raw: {},
    }));
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
      postMessage,
    } as never) as Adapter & { startGatewayListener: unknown };
    adapter.startGatewayListener = async (_opts: unknown, _ms: number, _signal: AbortSignal, url: string) => {
      webhookUrl = url;
      return new Response('{}');
    };
    // The host accepts the click unless a test says otherwise.
    const onAction = vi.fn().mockResolvedValue('accepted');
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: true,
      botToken: BOT_TOKEN,
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
          message: { id: 'card-1', embeds: [{ title: 'Review', description: 'Allow?' }] },
          ...extra,
        },
      });
    return { bridge, click, forward, onAction, editMessage, postMessage, handleWebhook };
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

  it('acks a Discord click, then edits the card once the host accepts it', async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord', review);
    try {
      expect((await click({ id: 'clicker-1', username: 'clicker', global_name: 'Clicker' })).status).toBe(200);
      // Acked at once; the buttons go only once the host accepts the click and the card edit settles.
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
      expect(edited.card.title).toBe('Review');
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

  it('acks within the time limit, then edits the card and removes the buttons only after the host accepts', async () => {
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
      await vi.waitFor(() => expect(order).toEqual(['acked', 'decision dispatched', 'card edited', 'buttons removed']));
    } finally {
      await bridge.teardown();
    }
  });

  it('never has the button removal and the card edit in flight together', async () => {
    const { bridge, click, editMessage } = await startDiscord('q-discord-serial', review);
    let finishEdit!: () => void;
    editMessage.mockImplementation(
      () => new Promise((resolve) => (finishEdit = () => resolve({ id: 'card-1', threadId: 't', raw: {} }))) as never,
    );
    const patches = () => discordCalls().filter(([method]) => method === 'PATCH');
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() => expect(editMessage).toHaveBeenCalledTimes(1));
      // Two edits of one message at once can drop the card text: the removal waits.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(patches()).toEqual([]);
      finishEdit();
      await vi.waitFor(() => expect(patches()).toEqual([['PATCH', ORIGINAL, { components: [] }]]));
    } finally {
      await bridge.teardown();
    }
  });

  it('removes the buttons anyway once a card edit has stalled for the settle time', async () => {
    const { bridge, click, editMessage } = await startDiscord('q-discord-edit-stalls', review);
    editMessage.mockImplementation(() => new Promise(() => {}) as never);
    const realSetTimeout = globalThis.setTimeout;
    const settleTimers: Array<() => void> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === CARD_EDIT_SETTLE_MS) {
        settleTimers.push(fn);
        return 0;
      }
      return realSetTimeout(fn, ms);
    }) as never);
    const patches = () => discordCalls().filter(([method]) => method === 'PATCH');
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() => expect(settleTimers).toHaveLength(1));
      expect(patches()).toEqual([]);
      settleTimers[0]();
      await vi.waitFor(() => expect(patches()).toEqual([['PATCH', ORIGINAL, { components: [] }]]));
    } finally {
      vi.mocked(globalThis.setTimeout).mockRestore();
      await bridge.teardown();
    }
  });

  it('still removes the buttons when the card edit fails', async () => {
    const { bridge, click, editMessage } = await startDiscord('q-discord-edit-fails', review);
    editMessage.mockRejectedValue(new Error('embed too long'));
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() =>
        expect(discordCalls().filter(([method]) => method === 'PATCH')).toEqual([
          ['PATCH', ORIGINAL, { components: [] }],
        ]),
      );
    } finally {
      await bridge.teardown();
    }
  });

  it('removes the buttons only after the shorter redraw of a refused card has ended', async () => {
    const { bridge, click, editMessage } = await startDiscord('q-discord-short-redraw', review);
    let endShort!: () => void;
    editMessage
      .mockRejectedValueOnce(new CardTooLongError('embed description is over 4096'))
      .mockImplementationOnce(
        () => new Promise((resolve) => (endShort = () => resolve({ id: 'card-1', threadId: 't', raw: {} }))),
      );
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() => expect(editMessage).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The shorter redraw is still in flight: the buttons stay.
      expect(discordCalls()).toEqual([['POST', CALLBACK, ACK]]);
      endShort();
      await vi.waitFor(() =>
        expect(discordCalls()).toEqual([
          ['POST', CALLBACK, ACK],
          ['PATCH', ORIGINAL, { components: [] }],
        ]),
      );
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

  it.each([10, 11, 12])(
    'addresses a click in a thread (channel type %i) by its parent channel and the thread, like a card sent into it',
    async (type) => {
      const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-thread', review);
      try {
        await click({ id: 'clicker-1', username: 'Ann' }, undefined, {
          channel_id: 'T1',
          channel: { id: 'T1', type, parent_id: 'P1' },
        });
        await vi.waitFor(() =>
          expect(onAction).toHaveBeenCalledWith('q-discord-thread', 'approve', 'clicker-1', {
            messageId: 'card-1',
            platformId: 'discord:G1:P1',
          }),
        );
        // The card is edited in the thread itself.
        await vi.waitFor(() =>
          expect(editMessage).toHaveBeenCalledWith('discord:G1:P1:T1', 'card-1', expect.anything()),
        );
      } finally {
        await bridge.teardown();
      }
    },
  );

  // The adapter keys a thread's chat by the thread alone when it could not tell the parent.
  it.each([10, 11, 12])(
    'addresses a click in a thread (channel type %i) by the thread alone when its card was sent to a chat keyed that way',
    async (type) => {
      const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-thread-chat', {
        ...review,
        platformId: 'discord:G1:T1',
      });
      try {
        await click({ id: 'clicker-1', username: 'Ann' }, undefined, {
          channel_id: 'T1',
          channel: { id: 'T1', type, parent_id: 'P1' },
        });
        await vi.waitFor(() =>
          expect(onAction).toHaveBeenCalledWith('q-discord-thread-chat', 'approve', 'clicker-1', {
            messageId: 'card-1',
            platformId: 'discord:G1:T1',
          }),
        );
        await vi.waitFor(() =>
          expect(editMessage).toHaveBeenCalledWith('discord:G1:P1:T1', 'card-1', expect.anything()),
        );
      } finally {
        await bridge.teardown();
      }
    },
  );

  it("keeps a thread click's own address when its card was sent to another chat", async () => {
    const { bridge, click, onAction } = await startDiscord('q-discord-other-chat', {
      ...review,
      platformId: 'discord:G1:T9',
    });
    try {
      await click({ id: 'clicker-1', username: 'Ann' }, undefined, {
        channel_id: 'T1',
        channel: { id: 'T1', type: 11, parent_id: 'P1' },
      });
      await vi.waitFor(() =>
        expect(onAction).toHaveBeenCalledWith('q-discord-other-chat', 'approve', 'clicker-1', {
          messageId: 'card-1',
          platformId: 'discord:G1:P1',
        }),
      );
    } finally {
      await bridge.teardown();
    }
  });

  // The real coordinator decides a durable approval only for a click from the
  // chat its card was sent to. A thread's chat is keyed one of two ways.
  it.each([
    ['its parent channel and the thread', 'discord:G1:P1', 'discord:G1:P1:T1'],
    ['the thread alone', 'discord:G1:T1', 'discord:G1:T1'],
  ])(
    'a durable gateway approval sent to a thread whose chat is keyed by %s is decided by a click in that thread',
    async (_name, platformId, threadId) => {
      const { createAgentGroup, createSession, getPendingApproval } = await import('../db/index.js');
      const { createMessagingGroup } = await import('../db/messaging-groups.js');
      const { gatewayRuntimeIdentity } = await import('../gateway-providers/index.js');
      const { INSTALL_SLUG } = await import('../config.js');
      const { dispatchResponse } = await import('../response-registry.js');
      const coordinator = await import('../gateway-approval-coordinator.js');
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
      await createMessagingGroup({
        id: 'mg-thread',
        channel_type: 'discord',
        platform_id: platformId,
        name: null,
        is_group: 1,
        unknown_sender_policy: 'request_approval',
        created_at: now,
      });
      const { bridge, click, onAction, postMessage, editMessage } = await startDiscord('q-unused', review);
      // As src/index.ts wires it.
      onAction.mockImplementation((questionId, value, userId, address) =>
        dispatchResponse({
          questionId,
          value,
          userId,
          channelType: 'discord',
          instance: address?.instance ?? 'discord',
          messageId: address?.messageId,
          platformId: address?.platformId ?? '',
          threadId: null,
        }),
      );
      const submitted: string[] = [];
      let decide!: (request: GatewayApprovalRequest) => Promise<string>;
      await coordinator.startGatewayApprovalCoordinator(
        {
          kind: 'fixture',
          agentSkills: [],
          sessions: {
            ensure: async () => ({
              contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } },
            }),
          },
          approvals: {
            durable: true,
            decide: async (_id, decision) => {
              submitted.push(decision);
              return true;
            },
            listPending: async () => [],
            async subscribe(callback, signal) {
              decide = callback;
              await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            },
          },
        },
        {
          deliver: (_channelType, chat, thread, kind, content) =>
            bridge.deliver(chat, thread, { kind, content: JSON.parse(content) }),
        },
        vi.fn(),
      );
      try {
        const decision = decide({
          id: 'native-request',
          agentGroupId: 'ag-1',
          sessionId: 'session-1',
          runtimeIdentity: gatewayRuntimeIdentity({
            installSlug: INSTALL_SLUG,
            agentGroupId: 'ag-1',
            sessionId: 'session-1',
          }),
          createdAt: now,
          title: 'Credential request',
          question: 'Allow POST api.example.test/resource?',
          audit: { method: 'POST', host: 'api.example.test' },
          approverUserId: 'discord:clicker-1',
          delivery: { messagingGroupId: 'mg-thread', threadId },
        });
        // The card goes into the thread under either key.
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(threadId, expect.anything()));
        const approvalId = /ncq:([^:"]+):0/.exec(JSON.stringify(postMessage.mock.calls[0][1]))![1];
        await vi.waitFor(async () =>
          expect((await getPendingApproval(approvalId))?.platform_message_id).toBe('card-1'),
        );
        const inThread = (id: string, parent: string) => ({
          channel_id: id,
          channel: { id, type: 11, parent_id: parent },
        });

        // The same card clicked from another thread decides nothing.
        await click({ id: 'clicker-1', username: 'Ann' }, `ncq:${approvalId}:0\n0`, inThread('T2', 'P2'));
        await vi.waitFor(async () => expect(await onAction.mock.results.at(-1)?.value).toBe('ignored'));
        expect((await getPendingApproval(approvalId))?.status).toBe('pending');

        await click({ id: 'clicker-1', username: 'Ann' }, `ncq:${approvalId}:0\n0`, inThread('T1', 'P1'));
        expect(await decision).toBe('approve');
        expect(onAction.mock.lastCall?.[3]).toEqual({ messageId: 'card-1', platformId });
        expect(submitted).toEqual(['approve']);
        // The host edits a gateway card itself, in the thread.
        await vi.waitFor(() => expect(editMessage).toHaveBeenCalledWith(threadId, 'card-1', expect.anything()));
        // Only the accepted click removes the buttons; the ignored one wrote nothing.
        await vi.waitFor(() =>
          expect(discordCalls().filter(([method]) => method === 'PATCH')).toEqual([
            ['PATCH', ORIGINAL, { components: [] }],
          ]),
        );
      } finally {
        await coordinator.stopGatewayApprovalCoordinator();
        await bridge.teardown();
      }
    },
  );

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

  /** The host's own redraw of a gateway card, as the coordinator sends it through the bridge. */
  const hostRedraw = (bridge: { deliver: ReturnType<typeof createChatSdkBridge>['deliver'] }) =>
    bridge.deliver('discord:G1:C1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'card-1',
        terminalCard: { title: 'Review', question: 'Allow?', resolution: '✅ Approved' },
      },
    });

  it("removes a gateway (deferred) card's buttons once the host has redrawn it and accepts", async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-gw-accepted', {
      ...review,
      deferResolution: true,
    });
    const order: string[] = [];
    editMessage.mockImplementation(async () => {
      order.push('host redraw');
      return { id: 'card-1', threadId: 't', raw: {} };
    });
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      if (String(url) === ORIGINAL) order.push('buttons removed');
      return new Response(null, { status: 204 });
    });
    onAction.mockImplementation(async () => {
      await hostRedraw(bridge);
      return 'accepted';
    });
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() => expect(order).toEqual(['host redraw', 'buttons removed']));
      expect(discordCalls()).toEqual([
        ['POST', CALLBACK, ACK],
        ['PATCH', ORIGINAL, { components: [] }],
      ]);
      // The redraw is the host's alone: the click path edits nothing.
      expect(editMessage).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
    }
  });

  it("still removes a gateway (deferred) card's buttons when the host's redraw fails", async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-gw-redraw-fails', {
      ...review,
      deferResolution: true,
    });
    editMessage.mockRejectedValue(new Error('Discord API error: 500'));
    onAction.mockImplementation(async () => {
      // As the coordinator: a failed redraw is logged, and the decision stands.
      await hostRedraw(bridge).catch(() => {});
      return 'accepted';
    });
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() =>
        expect(discordCalls()).toEqual([
          ['POST', CALLBACK, ACK],
          ['PATCH', ORIGINAL, { components: [] }],
        ]),
      );
      // The host tried the whole card, then the card with its decision only.
      expect(editMessage).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.teardown();
    }
  });

  it("keeps a gateway (deferred) card's buttons when the host ignores the click", async () => {
    const { bridge, click, onAction, editMessage } = await startDiscord('q-discord-gw-ignored', {
      ...review,
      deferResolution: true,
    });
    onAction.mockResolvedValue('ignored');
    try {
      await click({ id: 'clicker-1', username: 'Ann' });
      await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(discordCalls()).toEqual([['POST', CALLBACK, ACK]]);
      expect(editMessage).not.toHaveBeenCalled();
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

  it('a stalled private note holds no later click, and ends at its deadline', async () => {
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
      // The first click's note is stuck; the next click still reaches the host.
      await click({ id: 'bystander', username: 'Bob' });
      await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));

      deadlines.expire();
      await vi.waitFor(() =>
        expect(errors).toHaveBeenCalledWith('Discord interaction webhook failed', expect.anything()),
      );
      // Every call asked for the same bound.
      expect(new Set(deadlines.asked)).toEqual(new Set([10_000]));
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

it('escapes a host terminal card even when its row claims fromAgent', async () => {
  const edits: PostCall[] = [];
  const bridge = createChatSdkBridge({
    adapter: stubAdapter({
      editMessage: async (threadId, _id, message) => {
        edits.push({ threadId, message });
        return { id: 'card', threadId, raw: {} };
      },
    }),
    supportsThreads: false,
    escapeCardText: (t) => `[${t}]`,
  });
  await bridge.deliver('stub:C1', null, {
    kind: 'chat-sdk',
    content: {
      operation: 'edit',
      messageId: 'card',
      terminalCard: { title: 'Review', question: 'Allow <x>?', resolution: 'Approved', fromAgent: true },
    },
  });
  const edited = edits[0].message as { card: { children: Array<{ content?: string }> } };
  expect(edited.card.children.map((c) => c.content)).toEqual(['[Allow <x>?]', '[Approved]']);
});

async function answerStoredQuestion(caps: { maxCardTextLength?: number; maxTextLength?: number } = {}) {
  const { initTestDb, closeDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  const { createAgentGroup, createSession, createPendingQuestion } = await import('../db/index.js');
  await runMigrations(await initTestDb());
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: 'ag-q', name: 'Agent', folder: 'agent-q', agent_provider: null, created_at });
  await createSession({
    id: 'sess-q',
    agent_group_id: 'ag-q',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at,
  });
  await createPendingQuestion({
    question_id: 'body-fixture',
    session_id: 'sess-q',
    message_out_id: 'out-1',
    platform_id: 'fixture:room',
    channel_type: 'fixture',
    thread_id: null,
    title: 'Deploy',
    question: 'Ship **v2** today?',
    options: [{ label: 'Yes', selectedLabel: 'Yes', value: 'yes' }],
    created_at,
  });
  const editMessage = vi.fn(async () => ({ id: 'card', threadId: 'fixture:room', raw: {} }));
  const adapter = stubAdapter({
    name: 'fixture',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage,
  });
  const bridge = createChatSdkBridge({
    adapter,
    supportsThreads: false,
    escapeCardText: (t) => `[${t}]`,
    ...caps,
  });
  try {
    await bridge.setup({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: vi.fn(async () => 'accepted' as const),
    });
    const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
    await chat.processAction(
      {
        actionId: 'ncq:body-fixture:0',
        adapter,
        messageId: 'card',
        raw: {},
        threadId: 'fixture:room',
        user: { userId: 'u2', userName: 'ann' } as never,
        value: '0',
      },
      undefined,
    );
    await vi.waitFor(() => expect(editMessage).toHaveBeenCalledTimes(1));
    return (editMessage.mock.calls[0] as unknown[])[2];
  } finally {
    await bridge.teardown();
    await closeDb();
  }
}

it('keeps an answered agent question body on the card, unescaped, with an escaped resolution', async () => {
  const edited = (await answerStoredQuestion()) as {
    card: { title: string; children: Array<{ type: string; content?: string }> };
  };
  expect(edited.card.title).toBe('Deploy');
  expect(edited.card.children.map((c) => c.content)).toEqual(['Ship **v2** today?', '[Yes by ann]']);
});

it('drops the stored question when it no longer fits the card cap with its answer', async () => {
  // 'Deploy' + 'Ship **v2** today?' = 24 fits a cap of 30; with '[Yes by ann]' it would not.
  const edited = (await answerStoredQuestion({ maxCardTextLength: 30 })) as {
    card: { title: string; children: Array<{ content?: string }> };
  };
  expect(edited.card.title).toBe('Deploy');
  expect(edited.card.children.map((c) => c.content)).toEqual(['[Yes by ann]']);
});

it('keeps the question on a channel with no card cap, whatever its text cap', async () => {
  // Discord's 2,000 text cap is not its embed cap; only maxCardTextLength may drop the question.
  const edited = (await answerStoredQuestion({ maxTextLength: 30 })) as {
    card: { children: Array<{ content?: string }> };
  };
  expect(edited.card.children.map((c) => c.content)).toEqual(['Ship **v2** today?', '[Yes by ann]']);
});

describe('plain card titles at Markdown adapter boundaries', () => {
  it.each(['telegram', 'teams', 'webex', 'mattermost', 'slack'])('encodes card titles for %s', async (name) => {
    const { calls, postMessage } = makePostCapture();
    const editMessage = vi.fn(async () => ({ id: 'm', threadId: 't', raw: {} }));
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name, postMessage, editMessage }),
      supportsThreads: false,
    });
    const title = '[Admin](https://evil.test) file_a &#x202E;';
    await bridge.deliver('t', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'literal-title',
        title,
        question: 'Allow?',
        options: ['Approve'],
      },
    });
    await bridge.deliver('t', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'm',
        terminalCard: { title, question: 'Allow?', resolution: 'Approved' },
      },
    });
    const expected = name === 'slack' ? title : '\\[Admin\\]\\(https://evil.test\\) file\\_a \\&#x202E;';
    expect((calls[0].message as { card: { title: string } }).card.title).toBe(expected);
    expect((editMessage.mock.calls[0] as unknown as [string, string, { card: { title: string } }])[2].card.title).toBe(
      expected,
    );
  });
});

it('shows the Discord decision near the embed limit with an older adapter config', async () => {
  const editMessage = vi.fn(async () => ({ id: 'm', threadId: 't', raw: {} }));
  const bridge = createChatSdkBridge({ adapter: stubAdapter({ name: 'discord', editMessage }), supportsThreads: true });
  await bridge.deliver('t', null, {
    kind: 'chat-sdk',
    content: {
      operation: 'edit',
      messageId: 'm',
      terminalCard: { title: 'Approval', question: 'x'.repeat(3990), resolution: 'Approved by Alice' },
    },
  });
  const message = (editMessage.mock.calls[0] as unknown as [string, string, { fallbackText: string }])[2];
  expect(message.fallbackText).toContain('Approved by Alice');
  expect(message.fallbackText).not.toContain('x'.repeat(3990));
});
