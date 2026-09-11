/**
 * The pairing interceptor is instance-exact (createTelegramInboundInterceptor
 * in telegram.ts).
 *
 * What breaks without it: a chat paired on a named bot lands on, and rewrites,
 * the default bot's messaging-group row (so both bots' traffic shares one
 * session), and a code issued for one bot pairs on whichever bot sees it first.
 *
 * Kill conditions:
 *  - drop `instanceKey` from the getMessagingGroupByPlatform /
 *    createMessagingGroup calls: the second pairing updates the default row
 *    instead of creating its own ("two rows" goes red);
 *  - drop `instance: instanceKey` from the tryConsume input: the named bot
 *    looks its code up on the default instance and never pairs ("two rows"
 *    goes red); drop the instance guard from tryConsume's match in
 *    telegram-pairing.ts and the default bot consumes the named bot's code
 *    ("rejected on the default bot" goes red).
 *
 * Real central DB (migrations applied) and real pairing store (temp file); the
 * Telegram send boundary (fetch) is stubbed, so nothing reaches the network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getAllMessagingGroups, initTestDb, runMigrations } from '../db/index.js';
import type { InboundMessage } from './adapter.js';
import { _resetForTest, _setStorePathForTest, createPairing, getStatus } from './telegram-pairing.js';
import { createTelegramInboundInterceptor } from './telegram.js';

function message(text: string, userId: string): InboundMessage {
  return {
    id: 'message-1',
    kind: 'chat-sdk',
    content: { text, author: { userId } },
    timestamp: new Date().toISOString(),
  };
}

const hostOnInbound = vi.fn();
const onDefaultBot = createTelegramInboundInterceptor(
  Promise.resolve('NanoClawBot'),
  hostOnInbound,
  'tok-default',
  'telegram',
);
const onMegaBot = createTelegramInboundInterceptor(
  Promise.resolve('MegaBot'),
  hostOnInbound,
  'tok-mega',
  'telegram-mega',
);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pair-interceptor-'));
  _setStorePathForTest(path.join(tmpDir, 'pairings.json'));
  const db = await initTestDb();
  await runMigrations(db);
  hostOnInbound.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  );
});

afterEach(async () => {
  await closeDb();
  vi.unstubAllGlobals();
  _resetForTest();
  _setStorePathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Telegram pairing interceptor, instance-exact rows', () => {
  it('pairs the same chat on the default and a named bot as two rows, default row untouched', async () => {
    const forDefault = await createPairing('main');
    const forMega = await createPairing('main', 'telegram-mega');

    await onDefaultBot('telegram:42', null, message(forDefault.code, '42'));
    const [defaultRow] = await getAllMessagingGroups();
    expect(defaultRow).toMatchObject({ channel_type: 'telegram', platform_id: 'telegram:42', instance: 'telegram' });

    await onMegaBot('telegram:42', null, message(forMega.code, '42'));

    const rows = await getAllMessagingGroups();
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(defaultRow);
    expect(rows.map((r) => r.instance).sort()).toEqual(['telegram', 'telegram-mega']);
    expect(hostOnInbound).not.toHaveBeenCalled();
    // Each confirmation leaves through the bot that paired.
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.telegram.org/bottok-default/sendMessage',
      'https://api.telegram.org/bottok-mega/sendMessage',
    ]);
  });

  it("a named bot's code is rejected on the default bot and stays pending for the named bot", async () => {
    const forMega = await createPairing('main', 'telegram-mega');

    await onDefaultBot('telegram:42', null, message(forMega.code, '42'));

    expect(getStatus(forMega.code)).toBe('pending');
    expect(await getAllMessagingGroups()).toEqual([]);
    // Not a pairing for this bot: the message takes the normal inbound path.
    expect(hostOnInbound).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
