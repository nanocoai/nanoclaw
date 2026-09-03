/**
 * Guard for the slack-a2a-rooms admission policy and its registration.
 *
 * The skill's one reach-in is the barrel line `import './slack-a2a.js';` in
 * src/channels/index.ts: importing the module installs the A2A room policy on
 * the Slack channel layer's bot-inbound guard (setBotInboundPolicy). This
 * file drives that wiring end-to-end through the REAL guard: it imports the
 * real channel barrel — never ./slack-a2a.js directly, see the note at the
 * env-parsing describe — and sends bridge-shaped inbound through
 * wrapSlackBotGuard, asserting the policy's semantics:
 *
 *   - allowlisted rooms admit bot messages re-attributed as slack:bot:<bot_id>
 *   - non-listed rooms stay dropped; humans pass everywhere, untouched
 *   - the consecutive-hop limit drops bot messages until a human speaks
 *   - budgets are tracked per room and per bot identity (bridge instance)
 *   - a downstream throw does not consume hop budget
 *
 * If the barrel line is deleted (or the barrel fails to evaluate), no policy
 * is installed, the guard's default drop applies, and the admit test goes
 * red — exactly the composed-install failure this file guards. The guard's
 * own mechanics (default drop, human byte-identical pass-through, fail-closed
 * policy errors, non-Slack adapters untouched) are pinned by the channel
 * payload's slack-a2a-guard.test.ts, not here.
 *
 * Config is read from .env (SLACK_A2A_ROOMS / SLACK_A2A_MAX_HOPS) at first
 * decision, so the test chdirs into a temp dir carrying a crafted .env BEFORE
 * importing the barrel. Vitest's per-file process isolation keeps the chdir
 * and the module cache local to this file. No DB, no Slack.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import { wrapSlackBotGuard } from './slack-a2a-guard.js';

const originalCwd = process.cwd();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-a2a-'));
  writeFileSync(
    join(dir, '.env'),
    'SLACK_A2A_ROOMS=G0ALLOW,G0HOPS,G0ROOMA,G0ROOMB,G0INST,G0THROW\nSLACK_A2A_MAX_HOPS=2\n',
  );
  process.chdir(dir);
  await import('./index.js'); // the real barrel — installs the policy via the skill's barrel line
});

afterAll(() => {
  process.chdir(originalCwd);
});

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
function makeInbound(author: Record<string, unknown>, text: string): InboundMessage {
  const id = `msg-${++nextMessageId}`;
  return {
    id,
    kind: 'chat-sdk',
    content: { id, text, author, senderId: author.userId },
    timestamp: new Date().toISOString(),
    isGroup: true,
  };
}

function humanMsg(): InboundMessage {
  return makeInbound({ userId: 'U111', isBot: false, isMe: false }, 'hello');
}

function botMsg(botId = 'B999'): InboundMessage {
  return makeInbound({ userId: botId, isBot: true, isMe: false }, 'from a sibling bot');
}

describe('slack-a2a room policy (registered via the channel barrel)', () => {
  it('admits allowlisted bot messages re-attributed as slack:bot:<bot_id>', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    const msg = botMsg('B42');

    await wrapped.onInbound('slack:G0ALLOW', 'slack:G0ALLOW:171.1', msg);

    expect(calls).toHaveLength(1);
    expect((calls[0].message.content as Record<string, unknown>).senderId).toBe('slack:bot:B42');
  });

  it('drops bot messages for rooms not in SLACK_A2A_ROOMS', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound('slack:C0OTHER', null, botMsg());

    expect(calls).toHaveLength(0);
  });

  it('passes human messages through unchanged — allowlisted room or not', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    const inRoom = humanMsg();
    await wrapped.onInbound('slack:G0ALLOW', null, inRoom);
    const outsideRoom = humanMsg();
    await wrapped.onInbound('slack:C0OTHER', null, outsideRoom);

    expect(calls).toHaveLength(2);
    expect((calls[0].message.content as Record<string, unknown>).senderId).toBe('U111');
    expect((calls[1].message.content as Record<string, unknown>).senderId).toBe('U111');
  });

  it('enforces the consecutive-hop limit (SLACK_A2A_MAX_HOPS) and resets on a human message', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');
    const pid = 'slack:G0HOPS';

    await wrapped.onInbound(pid, null, botMsg('b1'));
    await wrapped.onInbound(pid, null, botMsg('b2'));
    expect(calls).toHaveLength(2);

    // Third consecutive bot message exceeds maxHops=2 — dropped.
    await wrapped.onInbound(pid, null, botMsg('b3'));
    expect(calls).toHaveLength(2);

    // A human message passes and resets the counter…
    await wrapped.onInbound(pid, null, humanMsg());
    expect(calls).toHaveLength(3);

    // …so bot messages flow again.
    await wrapped.onInbound(pid, null, botMsg('b4'));
    expect(calls).toHaveLength(4);
  });

  it('tracks the hop budget per room', async () => {
    const { setup, calls } = makeSetup();
    const wrapped = wrapSlackBotGuard(setup, 'slack');

    await wrapped.onInbound('slack:G0ROOMA', null, botMsg('a1'));
    await wrapped.onInbound('slack:G0ROOMA', null, botMsg('a2'));
    expect(calls).toHaveLength(2); // G0ROOMA at its limit (maxHops=2)

    await wrapped.onInbound('slack:G0ROOMA', null, botMsg('a3'));
    expect(calls).toHaveLength(2);

    // A different room has its own budget.
    await wrapped.onInbound('slack:G0ROOMB', null, botMsg('b1'));
    expect(calls).toHaveLength(3);
  });

  it('tracks the hop budget per bot identity (bridge instance)', async () => {
    const a = makeSetup();
    const b = makeSetup();
    const wrappedA = wrapSlackBotGuard(a.setup, 'slack');
    const wrappedB = wrapSlackBotGuard(b.setup, 'slack-dana');
    const pid = 'slack:G0INST';

    await wrappedA.onInbound(pid, null, botMsg('a1'));
    await wrappedA.onInbound(pid, null, botMsg('a2'));
    await wrappedA.onInbound(pid, null, botMsg('a3'));
    expect(a.calls).toHaveLength(2); // identity A exhausted its budget

    // Identity B in the same room still has a full budget.
    await wrappedB.onInbound(pid, null, botMsg('b1'));
    expect(b.calls).toHaveLength(1);
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
    const pid = 'slack:G0THROW';

    // Admitted, but downstream throws — the message never reached a session,
    // so the budget (maxHops=2) must be untouched.
    await expect(wrapped.onInbound(pid, null, botMsg('t1'))).rejects.toThrow('router exploded');

    // The full budget of two is still available…
    await wrapped.onInbound(pid, null, botMsg('t2'));
    await wrapped.onInbound(pid, null, botMsg('t3'));
    expect(calls).toHaveLength(2);

    // …and accounting still works: the third accepted hop is over the limit.
    await wrapped.onInbound(pid, null, botMsg('t4'));
    expect(calls).toHaveLength(2);
  });
});

describe('env parsing', () => {
  // Imported dynamically, and only in this describe, which runs AFTER the
  // behavior tests above: a static (or earlier) import of ./slack-a2a.js
  // would install the policy as a side effect of this test file itself and
  // mask a deleted barrel line. Via the barrel the module is already in the
  // cache, so this import is a no-op read.
  it('parseRooms splits, trims, and drops empties', async () => {
    const { parseRooms } = await import('./slack-a2a.js');
    expect([...parseRooms(' G0A , C0B ,,')]).toEqual(['G0A', 'C0B']);
    expect(parseRooms(undefined).size).toBe(0);
  });

  it('parseMaxHops falls back to the default on junk', async () => {
    const { parseMaxHops, DEFAULT_MAX_HOPS } = await import('./slack-a2a.js');
    expect(parseMaxHops('4')).toBe(4);
    expect(parseMaxHops('0')).toBe(DEFAULT_MAX_HOPS);
    expect(parseMaxHops('-2')).toBe(DEFAULT_MAX_HOPS);
    expect(parseMaxHops('six')).toBe(DEFAULT_MAX_HOPS);
    expect(parseMaxHops(undefined)).toBe(DEFAULT_MAX_HOPS);
  });
});
