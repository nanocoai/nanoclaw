/**
 * The reply split loop, driven through the real bridge `deliver` with a fake
 * adapter: a text over `maxTextLength` goes out as several posts, and a
 * delivery retry after a failed part resumes at that part.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import { closeDb, getDb, initDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { SqliteStateAdapter } from '../state-sqlite.js';
import type { ChannelAdapter, OutboundFile, OutboundMessage } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

interface Post {
  threadId: string;
  message: AdapterPostableMessage;
}

/** Records each post that lands, numbers the ids, and fails the calls `fails` picks. */
function fakeAdapter(fails: (call: number, markdown: string) => boolean = () => false) {
  const posts: Post[] = [];
  const tries: string[] = [];
  let calls = 0;
  const adapter = {
    name: 'stub',
    initialize: async () => {},
    postMessage: async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
      calls++;
      const markdown = (message as { markdown: string }).markdown;
      tries.push(markdown);
      if (fails(calls, markdown)) throw new Error(`post ${calls} failed`);
      posts.push({ threadId, message });
      return { id: `id-${posts.length}`, threadId, raw: {} };
    },
  } as unknown as Adapter;
  return { adapter, posts, tries };
}

const hostConfig = { onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction: () => {} };

async function splitBridge(adapter: Adapter, maxTextLength?: number): Promise<ChannelAdapter> {
  const bridge = createChatSdkBridge({ adapter, supportsThreads: false, maxTextLength });
  await bridge.setup(hostConfig);
  return bridge;
}

function textMessage(text: string, opts: { files?: OutboundFile[]; deliveryId?: string } = {}): OutboundMessage {
  return { kind: 'chat-sdk', content: { text }, ...opts };
}

const markdownOf = (posts: Post[]) => posts.map((p) => (p.message as { markdown: string }).markdown);

async function progressRows(): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM chat_sdk_kv WHERE key LIKE 'split-progress:%'",
  );
  return row?.n ?? 0;
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  vi.restoreAllMocks();
});

// Three parts under a limit of 12: each paragraph fits, no two fit together.
const TEXT = 'first part\n\nsecond part\n\nthird part';
const LIMIT = 12;

// Five parts under a limit of 10, for the retry cases.
const FIVE = 'part one\n\npart two\n\npart three\n\npart four\n\npart five';
const FIVE_LIMIT = 10;
const ALL_FIVE = ['part one', 'part two', 'part three', 'part four', 'part five'];
/** Delivery attempts the host makes before it marks a message failed (MAX_DELIVERY_ATTEMPTS in src/delivery.ts). */
const ATTEMPTS = 3;

describe('createChatSdkBridge.deliver — reply split loop', () => {
  it('posts a text over maxTextLength as one message per part, in order, each within the limit, carrying the whole text', async () => {
    const { adapter, posts } = fakeAdapter();
    // One cut of each kind at a limit of 16: paragraph break, line break,
    // space, then a hard cut inside the run of x. At each cut the next kind
    // down would cut somewhere else, so the order of preference shows.
    const text = `one two\n\nthree\nfour five six ${'x'.repeat(25)}`;

    await (await splitBridge(adapter, 16)).deliver('stub:C1', 'stub:C1:T1', textMessage(text));

    const parts = markdownOf(posts);
    expect(parts).toEqual(['one two', 'three', 'four five six', 'x'.repeat(16), 'x'.repeat(9)]);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(16);
    expect(posts.map((p) => p.threadId)).toEqual(Array(5).fill('stub:C1:T1'));
    // The break or space at a cut is in neither part; a hard cut drops nothing.
    const [p1, p2, p3, p4, p5] = parts;
    expect(`${p1}\n\n${p2}\n${p3} ${p4}${p5}`).toBe(text);
  });

  it('sends files with the first part only', async () => {
    const { adapter, posts } = fakeAdapter();
    const data = Buffer.from('file bytes');

    await (
      await splitBridge(adapter, LIMIT)
    ).deliver('stub:C1', null, textMessage(TEXT, { files: [{ filename: 'report.pdf', data }] }));

    expect(posts.map((p) => p.message)).toEqual([
      { markdown: 'first part', files: [{ data, filename: 'report.pdf' }] },
      { markdown: 'second part' },
      { markdown: 'third part' },
    ]);
  });

  it("returns the first part's id", async () => {
    const { adapter, posts } = fakeAdapter();

    const id = await (await splitBridge(adapter, LIMIT)).deliver('stub:C1', null, textMessage(TEXT));

    expect(posts).toHaveLength(3);
    expect(id).toBe('id-1');
  });

  it('posts a text at or under maxTextLength once, unchanged', async () => {
    for (const limit of [TEXT.length, TEXT.length + 1]) {
      const { adapter, posts } = fakeAdapter();

      await (await splitBridge(adapter, limit)).deliver('stub:C1', null, textMessage(TEXT));

      expect(posts.map((p) => p.message)).toEqual([{ markdown: TEXT }]);
    }
  });

  it('posts once, whatever the length, when the adapter sets no maxTextLength', async () => {
    const { adapter, posts } = fakeAdapter();
    const text = 'x'.repeat(50_000);

    await (await splitBridge(adapter)).deliver('stub:C1', null, textMessage(text));

    expect(posts.map((p) => p.message)).toEqual([{ markdown: text }]);
  });

  it('posts a very long text as many parts as it needs', async () => {
    const { adapter, posts } = fakeAdapter();
    const text = 'x'.repeat(1_000_000);

    await (await splitBridge(adapter, 2000)).deliver('stub:C1', null, textMessage(text, { deliveryId: 'out-long' }));

    expect(posts).toHaveLength(500);
    expect(markdownOf(posts).join('')).toBe(text);
  });
});

describe('createChatSdkBridge.deliver — retry after a failed part', () => {
  it('part 3 of 5 failing once: the retry posts parts 3 to 5 only, and returns part 1 id', async () => {
    const { adapter, posts } = fakeAdapter((call) => call === 3);
    const bridge = await splitBridge(adapter, FIVE_LIMIT);
    const message = textMessage(FIVE, { deliveryId: 'out-1' });

    await expect(bridge.deliver('stub:C1', null, message)).rejects.toThrow('post 3 failed');
    expect(markdownOf(posts)).toEqual(['part one', 'part two']);

    const id = await bridge.deliver('stub:C1', null, message);

    expect(markdownOf(posts)).toEqual(ALL_FIVE);
    expect(id).toBe('id-1');
  });

  it('a retry after every part landed (the delivery ack failed) posts nothing and returns part 1 id', async () => {
    const { adapter, posts } = fakeAdapter();
    const bridge = await splitBridge(adapter, FIVE_LIMIT);
    const message = textMessage(FIVE, { deliveryId: 'out-1' });

    await bridge.deliver('stub:C1', null, message);
    const id = await bridge.deliver('stub:C1', null, message);

    expect(markdownOf(posts)).toEqual(ALL_FIVE);
    expect(id).toBe('id-1');
    expect(await progressRows()).toBe(1);
  });

  it('part 3 of 5 failing on every attempt: parts 1 and 2 go out once, part 3 is retried each time', async () => {
    const { adapter, posts, tries } = fakeAdapter((_call, markdown) => markdown === 'part three');
    const bridge = await splitBridge(adapter, FIVE_LIMIT);

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      await expect(bridge.deliver('stub:C1', null, textMessage(FIVE, { deliveryId: 'out-1' }))).rejects.toThrow();
    }

    expect(markdownOf(posts)).toEqual(['part one', 'part two']);
    expect(tries).toEqual(['part one', 'part two', 'part three', 'part three', 'part three']);
  });

  it('a retry that starts after part 1 does not send the files again', async () => {
    const { adapter, posts } = fakeAdapter((call) => call === 2);
    const bridge = await splitBridge(adapter, LIMIT);
    const data = Buffer.from('file bytes');
    const message = textMessage(TEXT, { files: [{ filename: 'report.pdf', data }], deliveryId: 'out-1' });

    await expect(bridge.deliver('stub:C1', null, message)).rejects.toThrow();
    await bridge.deliver('stub:C1', null, message);

    expect(posts.map((p) => p.message)).toEqual([
      { markdown: 'first part', files: [{ data, filename: 'report.pdf' }] },
      { markdown: 'second part' },
      { markdown: 'third part' },
    ]);
  });

  it('part 1 failing: the retry starts at part 1, with the files', async () => {
    const { adapter, posts } = fakeAdapter((call) => call === 1);
    const bridge = await splitBridge(adapter, LIMIT);
    const data = Buffer.from('file bytes');
    const message = textMessage(TEXT, { files: [{ filename: 'report.pdf', data }], deliveryId: 'out-1' });

    await expect(bridge.deliver('stub:C1', null, message)).rejects.toThrow();
    const id = await bridge.deliver('stub:C1', null, message);

    expect(posts.map((p) => p.message)).toEqual([
      { markdown: 'first part', files: [{ data, filename: 'report.pdf' }] },
      { markdown: 'second part' },
      { markdown: 'third part' },
    ]);
    expect(id).toBe('id-1');
  });

  it('resumes after a host restart, from the progress saved in the database file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-split-progress-'));
    const file = path.join(dir, 'v2.db');
    try {
      await closeDb();
      await runMigrations(await initDb(file, { role: 'test' }));
      const first = fakeAdapter((call) => call === 3);
      await expect(
        (await splitBridge(first.adapter, FIVE_LIMIT)).deliver(
          'stub:C1',
          null,
          textMessage(FIVE, { deliveryId: 'out-1' }),
        ),
      ).rejects.toThrow();

      // The restart: the database closes, then a new bridge opens the same file.
      await closeDb();
      await runMigrations(await initDb(file, { role: 'test' }));
      const second = fakeAdapter();
      const id = await (
        await splitBridge(second.adapter, FIVE_LIMIT)
      ).deliver('stub:C1', null, textMessage(FIVE, { deliveryId: 'out-1' }));

      expect(markdownOf(first.posts)).toEqual(['part one', 'part two']);
      expect(markdownOf(second.posts)).toEqual(['part three', 'part four', 'part five']);
      expect(id).toBe('id-1');
    } finally {
      await closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts over when the parts differ from the failed attempt', async () => {
    const { adapter, posts } = fakeAdapter((call) => call === 3);
    const bridge = await splitBridge(adapter, FIVE_LIMIT);

    await expect(bridge.deliver('stub:C1', null, textMessage(FIVE, { deliveryId: 'out-1' }))).rejects.toThrow();
    await bridge.deliver('stub:C1', null, textMessage(TEXT.replace(/ part/g, ''), { deliveryId: 'out-1' }));

    expect(markdownOf(posts)).toEqual(['part one', 'part two', 'first', 'second', 'third']);
  });

  it('a retry after the delivery ack failed posts nothing, though the outbox files are gone by then', async () => {
    const { adapter, posts } = fakeAdapter();
    const bridge = await splitBridge(adapter, LIMIT);
    const data = Buffer.from('file bytes');

    await bridge.deliver(
      'stub:C1',
      null,
      textMessage(TEXT, { files: [{ filename: 'report.pdf', data }], deliveryId: 'out-1' }),
    );
    const id = await bridge.deliver('stub:C1', null, textMessage(TEXT, { deliveryId: 'out-1' }));

    expect(posts).toHaveLength(3);
    expect(id).toBe('id-1');
  });

  it('posts from part 1 on every attempt when the send has no delivery id', async () => {
    const { adapter, posts } = fakeAdapter((call) => call === 3);
    const bridge = await splitBridge(adapter, FIVE_LIMIT);

    await expect(bridge.deliver('stub:C1', null, textMessage(FIVE))).rejects.toThrow();
    await bridge.deliver('stub:C1', null, textMessage(FIVE));

    expect(markdownOf(posts)).toEqual(['part one', 'part two', ...ALL_FIVE]);
    expect(await progressRows()).toBe(0);
  });

  it('a failed progress read does not overwrite the progress it could not see', async () => {
    const { adapter, posts } = fakeAdapter((call) => call === 7);
    const bridge = await splitBridge(adapter, FIVE_LIMIT);
    const message = textMessage(FIVE, { deliveryId: 'out-1' });

    await bridge.deliver('stub:C1', null, message);
    // Retry after a failed ack: the read fails, so part 1 goes out again, then part 2 fails.
    vi.spyOn(SqliteStateAdapter.prototype, 'get').mockRejectedValueOnce(new Error('db locked'));
    await expect(bridge.deliver('stub:C1', null, message)).rejects.toThrow('post 7 failed');
    const id = await bridge.deliver('stub:C1', null, message);

    expect(markdownOf(posts)).toEqual([...ALL_FIVE, 'part one']);
    expect(id).toBe('id-1');
  });

  it('still delivers, from part 1, when the state store fails', async () => {
    const { adapter, posts } = fakeAdapter();
    const bridge = await splitBridge(adapter, FIVE_LIMIT);
    vi.spyOn(SqliteStateAdapter.prototype, 'get').mockRejectedValue(new Error('db locked'));
    vi.spyOn(SqliteStateAdapter.prototype, 'set').mockRejectedValue(new Error('db locked'));

    const id = await bridge.deliver('stub:C1', null, textMessage(FIVE, { deliveryId: 'out-1' }));

    expect(markdownOf(posts)).toEqual(ALL_FIVE);
    expect(id).toBe('id-1');
  });
});
