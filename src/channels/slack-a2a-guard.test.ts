/**
 * Tests for the Slack bot-authored inbound guard.
 *
 * The wrap is unit-tested directly (ChannelSetup in → ChannelSetup out, driven
 * with bridge-shaped inbound fixtures): human pass-through is byte-identical,
 * bot-authored inbound is dropped by default, and the admission-policy seam's
 * mechanics (admit / drop / re-attribution / accept-after-downstream) hold.
 * Allowlist, hop-limit, and attribution *semantics* belong to the
 * slack-a2a-rooms feature policy and are tested with it, not here.
 *
 * Registration note: this branch's bridge predates the inbound-policy seam
 * (`registerBridgeInboundPolicy`, trunk PR refa-b5-bridge-inbound-policy), so
 * the module's self-registration is a feature-detected no-op here and the
 * composed path (SDK dispatch → bridge → policy → host) cannot be driven on
 * this branch. `registerSlackBotGuard` is pinned against an injected registrar
 * instead: the guard registers for the `slack` channel type only, which is
 * what keeps non-Slack adapters untouched. The composed path is covered by
 * trunk's chat-sdk-bridge-inbound-policy.test.ts and activates automatically
 * once the seam forward-merges into this branch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';
import {
  botAuthorOf,
  registerSlackBotGuard,
  setBotInboundPolicy,
  wrapSlackBotGuard,
  type SlackBotInboundContext,
  type SlackBotInboundDecision,
} from './slack-a2a-guard.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let nextMessageId = 0;

/** Bridge-shaped inbound fixture (see chat-sdk-bridge.ts messageToInbound). */
function makeInbound(author: Record<string, unknown>, text = 'hello'): InboundMessage {
  const id = `msg-${++nextMessageId}`;
  return {
    id,
    kind: 'chat-sdk',
    content: {
      id,
      text,
      author,
      senderId: author.userId,
      sender: author.userName,
      senderName: author.userName,
    },
    timestamp: '2026-01-01T00:00:00.000Z',
    isMention: false,
    isGroup: true,
  };
}

function humanMessage(text = 'hello'): InboundMessage {
  return makeInbound({ userId: 'U123', userName: 'human', isBot: false, isMe: false }, text);
}

function botMessage(botId = 'B0AGENT', text = 'beep'): InboundMessage {
  return makeInbound({ userId: botId, userName: 'sibling-agent', isBot: true, isMe: false }, text);
}

interface InboundCall {
  platformId: string;
  threadId: string | null;
  message: InboundMessage;
}

function makeSetup(onInbound?: ChannelSetup['onInbound']): { setup: ChannelSetup; calls: InboundCall[] } {
  const calls: InboundCall[] = [];
  const setup: ChannelSetup = {
    onInbound:
      onInbound ??
      ((platformId, threadId, message) => {
        calls.push({ platformId, threadId, message });
      }),
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
  return { setup, calls };
}

afterEach(() => {
  setBotInboundPolicy(null);
  vi.clearAllMocks();
});

describe('botAuthorOf', () => {
  it('returns the bot id for a bot-authored message', () => {
    expect(botAuthorOf(botMessage('B0FOREIGN'))).toEqual({ botId: 'B0FOREIGN' });
  });

  it('returns null for a human-authored message', () => {
    expect(botAuthorOf(humanMessage())).toBeNull();
  });

  it('returns null when isBot is true but the bot is unattributable (no userId)', () => {
    expect(botAuthorOf(makeInbound({ isBot: true, userName: 'ghost' }))).toBeNull();
  });

  it('returns null when content has no author or is not an object', () => {
    const noAuthor: InboundMessage = { ...humanMessage(), content: { text: 'x' } };
    expect(botAuthorOf(noAuthor)).toBeNull();
    const stringContent: InboundMessage = { ...humanMessage(), content: 'just text' };
    expect(botAuthorOf(stringContent)).toBeNull();
  });
});

describe('wrapSlackBotGuard — default (no admission policy)', () => {
  it('passes human-authored inbound through byte-identical', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    const message = humanMessage('untouched');
    const snapshot = JSON.parse(JSON.stringify(message));

    await wrapped.onInbound('slack:C1', 'slack:C1:T1', message);

    expect(calls).toHaveLength(1);
    expect(calls[0].platformId).toBe('slack:C1');
    expect(calls[0].threadId).toBe('slack:C1:T1');
    expect(calls[0].message).toBe(message); // same object, not a copy
    expect(calls[0].message).toEqual(snapshot); // and no field was mutated
  });

  it('drops bot-authored inbound with a debug log — never reaches the host', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound('slack:C1', 'slack:C1:T1', botMessage('B0FOREIGN'));

    expect(calls).toHaveLength(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('bot-authored inbound dropped'),
      expect.objectContaining({ botId: 'B0FOREIGN', platformId: 'slack:C1', instanceKey: 'slack' }),
    );
  });

  it('leaves the other ChannelSetup members untouched (pass-through references)', () => {
    const { setup } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    expect(wrapped).not.toBe(setup);
    expect(wrapped.onInbound).not.toBe(setup.onInbound);
    expect(wrapped.onInboundEvent).toBe(setup.onInboundEvent);
    expect(wrapped.onMetadata).toBe(setup.onMetadata);
    expect(wrapped.onAction).toBe(setup.onAction);
  });
});

describe('wrapSlackBotGuard — admission-policy seam', () => {
  it('consults the policy with full context and admits when it says admit', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack-tester');
    const seen: SlackBotInboundContext[] = [];
    setBotInboundPolicy({
      decideBotInbound(ctx) {
        seen.push(ctx);
        return { action: 'admit' };
      },
    });
    const message = botMessage('B0SIBLING');

    await wrapped.onInbound('slack:G7', 'slack:G7:T1', message);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      instanceKey: 'slack-tester',
      platformId: 'slack:G7',
      threadId: 'slack:G7:T1',
      botId: 'B0SIBLING',
    });
    expect(seen[0].message).toBe(message);
    expect(calls).toHaveLength(1);
    // No senderId in the decision — content is not re-attributed.
    expect((calls[0].message.content as Record<string, unknown>).senderId).toBe('B0SIBLING');
  });

  it('re-attributes content.senderId before the host sees the message', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    setBotInboundPolicy({
      decideBotInbound: (ctx) => ({ action: 'admit', senderId: `slack:bot:${ctx.botId}` }),
    });

    await wrapped.onInbound('slack:G7', null, botMessage('B0SIBLING'));

    expect(calls).toHaveLength(1);
    expect((calls[0].message.content as Record<string, unknown>).senderId).toBe('slack:bot:B0SIBLING');
  });

  it('calls onAccepted only after downstream accepted (resolved without throwing)', async () => {
    const order: string[] = [];
    const { setup } = makeSetup(async () => {
      order.push('downstream');
    });
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    setBotInboundPolicy({
      decideBotInbound: () => ({ action: 'admit', onAccepted: () => order.push('accepted') }),
    });

    await wrapped.onInbound('slack:G7', null, botMessage());

    expect(order).toEqual(['downstream', 'accepted']);
  });

  it('does not call onAccepted when downstream throws — the error propagates', async () => {
    const onAccepted = vi.fn();
    const { setup } = makeSetup(async () => {
      throw new Error('router exploded');
    });
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    setBotInboundPolicy({
      decideBotInbound: () => ({ action: 'admit', onAccepted }),
    });

    await expect(wrapped.onInbound('slack:G7', null, botMessage())).rejects.toThrow('router exploded');
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('drops when the policy says drop', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    setBotInboundPolicy({
      decideBotInbound: () => ({ action: 'drop', reason: 'room not allowlisted' }),
    });

    await wrapped.onInbound('slack:C1', null, botMessage());

    expect(calls).toHaveLength(0);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('dropped by policy'),
      expect.objectContaining({ reason: 'room not allowlisted' }),
    );
  });

  it('fails closed when the policy throws: bot message dropped, warning logged', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    setBotInboundPolicy({
      decideBotInbound: () => {
        throw new Error('policy bug');
      },
    });

    await expect(wrapped.onInbound('slack:C1', null, botMessage())).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('dropping bot-authored inbound'), expect.anything());
  });

  it('never consults decideBotInbound for human messages; onHumanInbound observes them', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    const decideBotInbound = vi.fn<() => SlackBotInboundDecision>(() => ({ action: 'drop' }));
    const onHumanInbound = vi.fn();
    setBotInboundPolicy({ decideBotInbound, onHumanInbound });
    const message = humanMessage();

    await wrapped.onInbound('slack:C1', 'slack:C1:T1', message);

    expect(decideBotInbound).not.toHaveBeenCalled();
    expect(onHumanInbound).toHaveBeenCalledWith({
      instanceKey: 'slack',
      platformId: 'slack:C1',
      threadId: 'slack:C1:T1',
      message,
    });
    expect(calls).toHaveLength(1); // observe-only — the human message still passes
  });

  it('passes human messages through even when the onHumanInbound observer throws', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    setBotInboundPolicy({
      decideBotInbound: () => ({ action: 'drop' }),
      onHumanInbound: () => {
        throw new Error('observer bug');
      },
    });

    await wrapped.onInbound('slack:C1', null, humanMessage());

    expect(calls).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('human message unaffected'), expect.anything());
  });

  it('clearing the policy (null) restores the default drop', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    setBotInboundPolicy({ decideBotInbound: () => ({ action: 'admit' }) });
    setBotInboundPolicy(null);

    await wrapped.onInbound('slack:C1', null, botMessage());

    expect(calls).toHaveLength(0);
  });

  it('overwriting an installed policy warns (single-provider discipline)', () => {
    setBotInboundPolicy({ decideBotInbound: () => ({ action: 'drop' }) });
    expect(log.warn).not.toHaveBeenCalled();
    setBotInboundPolicy({ decideBotInbound: () => ({ action: 'drop' }) });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('policy overwritten'));
  });
});

describe('registerSlackBotGuard', () => {
  it("registers the wrap for the 'slack' channel type only — non-Slack bridges stay untouched", () => {
    const registered: Array<[string, unknown]> = [];
    registerSlackBotGuard((channelType, wrap) => {
      registered.push([channelType, wrap]);
    });
    expect(registered).toEqual([['slack', wrapSlackBotGuard]]);
  });
});
