/**
 * Guard for the Slack coding-session surface skill and its registrations.
 *
 * The skill's two reach-ins are the barrel lines
 * `import './slack-code-surfaces.js';` and
 * `import './slack-code-surfaces-policy.js';` in src/channels/index.ts.
 * This file imports the REAL channel barrel — never the payload modules
 * directly, so a deleted barrel line goes red here — and asserts:
 *
 *   - the Slack platform half is on the surface module's platform registry
 *     and spells a channel the way the adapter does (`slack:C…`);
 *   - the admission policy is on the guard's chain by name, and, driven
 *     through the real guard wrap with a swapped record lookup: members are
 *     admitted as `slack:bot:<id>`, non-members and the manager are dropped,
 *     the hop cap holds and a human resets it, the routing header's `hops`
 *     and `addressed_to` are honoured, a channel that is not a surface is
 *     left to the rest of the chain, and a lookup failure fails closed for
 *     bots and open for humans;
 *   - a denial on a surface channel is final whatever else is on the chain,
 *     while a channel that is not a surface is passed on;
 *   - the hop budget is reserved at admit time, so simultaneous messages
 *     cannot all pass under one count;
 *   - the manager's system notices (no bot id) are dropped in a surface
 *     channel and nowhere else;
 *   - the bot identity lookup caches one auth.test answer under data/.
 *
 * The guard's own mechanics are pinned by slack-a2a-guard.test.ts; the
 * surface module's provider by its own tests. No DB, no Slack, no service.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSurfacePlatform, type SurfacePlatform } from '../modules/community-portal/surface/platforms.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import {
  addBotInboundPolicy,
  assertBotInboundPolicy,
  BOT_INBOUND_POLICY_SEAM,
  botInboundPolicyNames,
  wrapSlackBotGuard,
} from './slack-a2a-guard.js';
import type { SurfaceRecordView } from './slack-code-surfaces-policy.js';

// The payload modules are never imported statically: importing one installs
// its registration as a side effect of this file and would mask a deleted
// barrel line. The barrel is imported in beforeAll, what it registered is
// captured right after, and only then are the payload's helpers read from
// the module cache the barrel filled.
type PolicyModule = typeof import('./slack-code-surfaces-policy.js');
type SurfacesModule = typeof import('./slack-code-surfaces.js');
type IdentityModule = typeof import('./slack-bot-identity.js');
let policyModule: PolicyModule;
let surfacesModule: SurfacesModule;
let identityModule: IdentityModule;
let registeredByBarrel: { platform: SurfacePlatform | undefined; policies: string[] };

beforeAll(async () => {
  await import('./index.js'); // the real barrel — installs the platform half and the policy via the skill's barrel lines
  registeredByBarrel = { platform: getSurfacePlatform('slack'), policies: botInboundPolicyNames() };
  policyModule = await import('./slack-code-surfaces-policy.js');
  surfacesModule = await import('./slack-code-surfaces.js');
  identityModule = await import('./slack-bot-identity.js');
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

interface InboundCall {
  platformId: string;
  message: InboundMessage;
}

function makeSetup(onInbound?: ChannelSetup['onInbound']): { setup: ChannelSetup; calls: InboundCall[] } {
  const calls: InboundCall[] = [];
  const setup: ChannelSetup = {
    onInbound:
      onInbound ??
      ((platformId, _threadId, message) => {
        calls.push({ platformId, message });
      }),
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
  return { setup, calls };
}

let nextMessageId = 0;

/** Bridge-shaped inbound fixture (see chat-sdk-bridge.ts messageToInbound). */
function makeInbound(
  author: Record<string, unknown>,
  text: string,
  extra: Record<string, unknown> = {},
): InboundMessage {
  const id = `msg-${++nextMessageId}`;
  return {
    id,
    kind: 'chat-sdk',
    content: { id, text, author, senderId: author.userId, ...extra },
    timestamp: new Date().toISOString(),
    isMention: false,
    isGroup: true,
  };
}

const human = (text = 'hello', userId = 'U0HUMAN') => makeInbound({ userId, isBot: false, isMe: false }, text);
const bot = (userId: string, text = 'from a sibling', extra: Record<string, unknown> = {}) =>
  makeInbound({ userId, isBot: true, isMe: false }, text, extra);
const header = (payload: Record<string, unknown>) => ({
  metadata: { event_type: 'nanoclaw_agent', event_payload: payload },
});
const senderOf = (call: InboundCall) => (call.message.content as Record<string, unknown>).senderId;

const SURFACE = 'C0SURFACE';
const OTHER = 'C0ELSEWHERE';

const record: SurfaceRecordView = {
  botUserId: 'U0OURBOT',
  managerBotUserId: 'U0MANAGER',
  members: [
    { botUserId: 'U0OURBOT', role: 'owner', sandboxName: 'site-api' },
    { botUserId: 'U0SIBLING', role: 'member', sandboxName: 'site-web' },
    { botUserId: 'U0LISTEDMGR', role: 'manager' },
  ],
};

let lookups: string[];
let clock: number;
let removeRoomsLike: (() => void) | undefined;

beforeEach(() => {
  lookups = [];
  clock = 1_000_000;
  policyModule.resetSlackCodeSurfacesPolicyForTesting();
  policyModule.setSlackCodeSurfacesPolicyDeps({
    lookup: async (channelId) => {
      lookups.push(channelId);
      return channelId === SURFACE ? record : null;
    },
    ownBotUserId: async () => 'U0OURBOT',
    maxHops: () => 2,
    now: () => clock,
  });
});

afterEach(() => {
  removeRoomsLike?.();
  removeRoomsLike = undefined;
  policyModule.setSlackCodeSurfacesPolicyDeps(null);
  policyModule.resetSlackCodeSurfacesPolicyForTesting();
  vi.clearAllMocks();
});

describe('registrations (through the real channel barrel)', () => {
  it('registers the Slack platform half on the surface module', () => {
    const { platform } = registeredByBarrel;
    expect(platform).toBeDefined();
    expect(platform?.channelType).toBe('slack');
    expect(platform?.spell('C0123ABC')).toEqual({ platformId: 'slack:C0123ABC', instance: 'slack' });
    expect(platform?.botIdentity).toBeTypeOf('function');
  });

  it('registers the admission policy on the guard chain by name', () => {
    expect(registeredByBarrel.policies).toContain('slack-code-surfaces');
    expect(registeredByBarrel.policies).toContain(policyModule.SLACK_CODE_SURFACES_POLICY);
    expect(() => assertBotInboundPolicy(policyModule.SLACK_CODE_SURFACES_POLICY)).not.toThrow();
  });
});

describe('spelling', () => {
  it('asks the live adapter for its own encoding when it is running', () => {
    const adapter = {
      conversationPlatformId: (id: string) => `slack:${id.toLowerCase()}`,
      instance: 'slack-alpha',
      channelType: 'slack',
    } as unknown as ChannelAdapter;
    expect(surfacesModule.spellSlackSurface('C0ABC', adapter)).toEqual({
      platformId: 'slack:c0abc',
      instance: 'slack-alpha',
    });
  });

  it('falls back to the plain form when the adapter refuses the id or is not running', () => {
    const refusing = {
      conversationPlatformId: () => {
        throw new Error('bad id');
      },
      channelType: 'slack',
    } as unknown as ChannelAdapter;
    expect(surfacesModule.spellSlackSurface('C0ABC', refusing)).toEqual({
      platformId: 'slack:C0ABC',
      instance: 'slack',
    });
    expect(surfacesModule.spellSlackSurface('C0ABC', undefined)).toEqual({
      platformId: 'slack:C0ABC',
      instance: 'slack',
    });
  });
});

describe('admission on a surface channel (through the real guard)', () => {
  it('admits a listed member re-attributed as slack:bot:<id>', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0SIBLING'));

    expect(calls).toHaveLength(1);
    expect(senderOf(calls[0])).toBe('slack:bot:U0SIBLING');
  });

  it('drops a bot the record does not list', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0STRANGER'));

    expect(calls).toHaveLength(0);
  });

  it('never admits the manager, named by the record or listed with the manager role', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0MANAGER', 'status: processing'));
    await wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0LISTEDMGR', 'status: processing'));

    expect(calls).toHaveLength(0);
  });

  it('enforces the hop cap per channel and identity, and a human message resets it', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    const pid = `slack:${SURFACE}`;

    await wrapped.onInbound(pid, null, bot('U0SIBLING', 'one'));
    await wrapped.onInbound(pid, null, bot('U0SIBLING', 'two'));
    await wrapped.onInbound(pid, null, bot('U0SIBLING', 'three'));
    expect(calls).toHaveLength(2);

    await wrapped.onInbound(pid, null, human());
    await wrapped.onInbound(pid, null, bot('U0SIBLING', 'four'));
    expect(calls.map((c) => (c.message.content as { text: string }).text)).toEqual(['one', 'two', 'hello', 'four']);

    // Another bridge instance in the same channel has its own budget.
    const other = makeSetup();
    await wrapSlackBotGuard(other.setup, 'slack-beta').onInbound(pid, null, bot('U0SIBLING', 'five'));
    expect(other.calls).toHaveLength(1);
  });

  it('does not consume hop budget when downstream throws', async () => {
    let failNext = true;
    const calls: InboundCall[] = [];
    const { setup } = makeSetup(async (platformId, _threadId, message) => {
      if (failNext) {
        failNext = false;
        throw new Error('router exploded');
      }
      calls.push({ platformId, message });
    });
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    const pid = `slack:${SURFACE}`;

    await expect(wrapped.onInbound(pid, null, bot('U0SIBLING'))).rejects.toThrow('router exploded');
    await wrapped.onInbound(pid, null, bot('U0SIBLING'));
    await wrapped.onInbound(pid, null, bot('U0SIBLING'));
    await wrapped.onInbound(pid, null, bot('U0SIBLING'));
    expect(calls).toHaveLength(2);
  });

  it('honours the routing header: hops at the cap drop, addressed_to must name this host', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    const pid = `slack:${SURFACE}`;

    await wrapped.onInbound(pid, null, bot('U0SIBLING', 'looping', header({ hops: 2 })));
    await wrapped.onInbound(pid, null, bot('U0SIBLING', 'for someone else', header({ addressed_to: ['U0THIRD'] })));
    expect(calls).toHaveLength(0);

    await wrapped.onInbound(
      pid,
      null,
      bot('U0SIBLING', 'for our bot', header({ hops: 1, addressed_to: ['U0OURBOT'] })),
    );
    await wrapped.onInbound(pid, null, bot('U0SIBLING', 'for our sandbox', header({ addressed_to: ['site-api'] })));
    expect(calls.map((c) => (c.message.content as { text: string }).text)).toEqual(['for our bot', 'for our sandbox']);
  });

  it('reads the record once per channel within the TTL and forgets a miss after its own', async () => {
    const { setup } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0SIBLING'));
    await wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0SIBLING'));
    await wrapped.onInbound(`slack:${OTHER}`, null, bot('U0SIBLING'));
    await wrapped.onInbound(`slack:${OTHER}`, null, bot('U0SIBLING'));
    expect(lookups).toEqual([SURFACE, OTHER]);

    clock += 61_000;
    await wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0SIBLING'));
    await wrapped.onInbound(`slack:${OTHER}`, null, bot('U0SIBLING'));
    expect(lookups).toEqual([SURFACE, OTHER, SURFACE]); // the miss is still remembered

    clock += 5 * 60_000;
    await wrapped.onInbound(`slack:${OTHER}`, null, bot('U0SIBLING'));
    expect(lookups).toEqual([SURFACE, OTHER, SURFACE, OTHER]);
  });

  it('holds the cap for messages arriving together: cap 1, three at once, exactly one admitted', async () => {
    policyModule.setSlackCodeSurfacesPolicyDeps({
      lookup: async (channelId) => (channelId === SURFACE ? record : null),
      ownBotUserId: async () => 'U0OURBOT',
      maxHops: () => 1,
      now: () => clock,
    });
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    const pid = `slack:${SURFACE}`;

    await Promise.all([
      wrapped.onInbound(pid, null, bot('U0SIBLING', 'a')),
      wrapped.onInbound(pid, null, bot('U0SIBLING', 'b')),
      wrapped.onInbound(pid, null, bot('U0SIBLING', 'c')),
    ]);

    expect(calls).toHaveLength(1);
  });

  it('shares one read between rapid lookups for the same channel', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await Promise.all([
      wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0SIBLING', 'one')),
      wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0SIBLING', 'two')),
    ]);

    expect(lookups).toEqual([SURFACE]);
    expect(calls).toHaveLength(2);
  });

  it('fails closed for bots and open for humans when the record cannot be read', async () => {
    policyModule.setSlackCodeSurfacesPolicyDeps({
      lookup: async () => {
        throw new Error('service down');
      },
    });
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0SIBLING'));
    await wrapped.onInbound(`slack:${SURFACE}`, null, human());

    expect(calls).toHaveLength(1);
    expect(senderOf(calls[0])).toBe('U0HUMAN');
  });
});

describe('finality on the chain', () => {
  const rooms = (): void => {
    // A rooms-style policy that admits everything in the surface channel,
    // registered on the chain beside the skill's policy.
    removeRoomsLike = addBotInboundPolicy(
      'rooms-like',
      { decideBotInbound: () => ({ action: 'admit' }) },
      { seam: BOT_INBOUND_POLICY_SEAM },
    );
  };

  it('a denial on a surface channel is not overridden by a later policy that admits', async () => {
    rooms(); // registered after the skill's policy (apply order: this skill, then rooms)
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0MANAGER', 'status: processing'));
    await wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0STRANGER'));
    await wrapped.onInbound(`slack:${SURFACE}`, null, bot('U0SIBLING'));

    expect(calls.map(senderOf)).toEqual(['slack:bot:U0SIBLING']);
  });

  it('a channel that is not a surface is passed on to the next policy', async () => {
    rooms();
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound(`slack:${OTHER}`, null, bot('U0MANAGER'));

    expect(calls).toHaveLength(1); // the rooms-like policy admitted it
  });
});

describe('channels that are not a surface this host is on', () => {
  it('leaves bot posts to the rest of the chain (dropped here, no other policy) and passes humans', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound(`slack:${OTHER}`, null, bot('U0SIBLING'));
    await wrapped.onInbound(`slack:${OTHER}`, null, human('hi', 'U0MANAGER'));
    await wrapped.onInbound(`slack:${OTHER}`, null, human('hi', 'USLACKBOT'));

    expect(calls.map(senderOf)).toEqual(['U0MANAGER', 'USLACKBOT']); // no notice filter outside a surface
  });
});

describe('the notice filter on a surface channel', () => {
  it("drops the manager's, a member's and the platform's lines that arrive without a bot id", async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    const pid = `slack:${SURFACE}`;
    await wrapped.onInbound(pid, null, bot('U0SIBLING', 'warms the record')); // a bot message reads the record

    await wrapped.onInbound(pid, null, human('added view: diff', 'U0MANAGER'));
    await wrapped.onInbound(pid, null, human('joined the session', 'U0SIBLING'));
    await wrapped.onInbound(pid, null, human('set the topic', 'USLACKBOT'));
    await wrapped.onInbound(pid, null, human('please deploy', 'U0HUMAN'));

    expect(calls.map(senderOf)).toEqual(['slack:bot:U0SIBLING', 'U0HUMAN']);
  });

  it('never makes a human message wait on the service: an unseen channel passes and is read in the background', async () => {
    let resolveLookup: (record: SurfaceRecordView | null) => void = () => {};
    const started: string[] = [];
    policyModule.setSlackCodeSurfacesPolicyDeps({
      lookup: (channelId) =>
        new Promise<SurfaceRecordView | null>((resolve) => {
          started.push(channelId);
          resolveLookup = resolve;
        }),
    });
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    const pid = `slack:${SURFACE}`;

    await wrapped.onInbound(pid, null, human('added view: diff', 'U0MANAGER')); // lookup still pending
    expect(calls).toHaveLength(1); // delivered without waiting
    expect(started).toEqual([SURFACE]); // the read was started in the background

    resolveLookup(record);
    await new Promise((r) => setTimeout(r, 0));
    await wrapped.onInbound(pid, null, human('added view: diff', 'U0MANAGER'));
    expect(calls).toHaveLength(1); // now known: the notice is dropped
  });

  it('skips the lookup outright for a DM or group DM id', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound('slack:D0DIRECT', null, human('hi', 'U0MANAGER'));

    expect(calls).toHaveLength(1);
    expect(lookups).toEqual([]);
  });

  it('does not reset the hop budget for a notice', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    const pid = `slack:${SURFACE}`;

    await wrapped.onInbound(pid, null, bot('U0SIBLING'));
    await wrapped.onInbound(pid, null, bot('U0SIBLING'));
    await wrapped.onInbound(pid, null, human('added view: diff', 'U0MANAGER'));
    await wrapped.onInbound(pid, null, bot('U0SIBLING'));

    expect(calls).toHaveLength(2);
  });
});

describe('agentHeaderOf', () => {
  it('reads the nanoclaw_agent header from the content metadata or the raw event', () => {
    const payload = {
      sender_bot: 'U0SIB',
      sandbox: 'site-web',
      account: 'acct',
      hops: 2.7,
      task: 'T1',
      addressed_to: ['a', 1, ''],
    };
    expect(policyModule.agentHeaderOf({ metadata: { event_type: 'nanoclaw_agent', event_payload: payload } })).toEqual({
      senderBot: 'U0SIB',
      sandbox: 'site-web',
      account: 'acct',
      hops: 2,
      task: 'T1',
      addressedTo: ['a'],
    });
    expect(
      policyModule.agentHeaderOf({ raw: { metadata: { event_type: 'nanoclaw_agent', event_payload: { hops: 1 } } } }),
    ).toEqual({
      hops: 1,
    });
  });

  it('is null for a human post, another event type, or a malformed payload', () => {
    expect(policyModule.agentHeaderOf({ text: 'hi' })).toBeNull();
    expect(policyModule.agentHeaderOf({ metadata: { dateSent: '2026-01-01T00:00:00Z' } })).toBeNull();
    expect(policyModule.agentHeaderOf({ metadata: { event_type: 'other', event_payload: { hops: 1 } } })).toBeNull();
    expect(policyModule.agentHeaderOf({ metadata: { event_type: 'nanoclaw_agent', event_payload: 'junk' } })).toEqual(
      {},
    );
    expect(policyModule.agentHeaderOf('text')).toBeNull();
  });
});

describe('bot identity', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-slack-surface-'));
    fs.mkdirSync(path.join(root, 'data'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers from one auth.test, caches it under data/ without the token, and reuses it', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(input)} ${(init?.headers as Record<string, string>).authorization}`);
      return new Response(JSON.stringify({ ok: true, user_id: 'U0BOT1', team_id: 'T0TEAM1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const first = await identityModule.resolveBotIdentity({
      root,
      appId: 'A0APP',
      botToken: 'xoxb-secret',
      fetch: fetchFn,
    });
    const second = await identityModule.resolveBotIdentity({
      root,
      appId: 'A0APP',
      botToken: 'xoxb-secret',
      fetch: fetchFn,
    });

    expect(first).toEqual({ botUserId: 'U0BOT1', teamId: 'T0TEAM1' });
    expect(second).toEqual(first);
    expect(calls).toEqual(['POST https://slack.com/api/auth.test Bearer xoxb-secret']);
    const cached = fs.readFileSync(path.join(root, 'data/slack-bot-identity.json'), 'utf8');
    expect(cached).not.toContain('xoxb-secret');
    expect(await identityModule.readCachedBotIdentity(root, 'A0APP')).toEqual(first);
    expect(await identityModule.readCachedBotIdentity(root, 'A0OTHER')).toBeNull();
  });

  it('resolves null without a token or when the platform refuses', async () => {
    expect(await identityModule.resolveBotIdentity({ root, appId: 'A0APP' })).toBeNull();
    const refusing = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(
      await identityModule.resolveBotIdentity({ root, appId: 'A0APP', botToken: 'xoxb-bad', fetch: refusing }),
    ).toBeNull();
    expect(fs.existsSync(path.join(root, 'data/slack-bot-identity.json'))).toBe(false);
  });
});
