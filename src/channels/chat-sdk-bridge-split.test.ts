/**
 * The reply split loop, driven through the real bridge `deliver` with a fake
 * adapter: a text over `maxTextLength` goes out as several posts.
 *
 * The tests titled "today:" pin known limits of the loop as it is now.
 * They are not a wanted contract; change them with the loop (#4227).
 */
import { describe, expect, it } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import type { OutboundFile, OutboundMessage } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

interface Post {
  threadId: string;
  message: AdapterPostableMessage;
}

/** Records each post that lands, numbers the ids, and fails the calls `fails` picks. */
function fakeAdapter(fails: (call: number, markdown: string) => boolean = () => false) {
  const posts: Post[] = [];
  let calls = 0;
  const adapter = {
    name: 'stub',
    postMessage: async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
      calls++;
      if (fails(calls, (message as { markdown: string }).markdown)) throw new Error(`post ${calls} failed`);
      posts.push({ threadId, message });
      return { id: `id-${posts.length}`, threadId, raw: {} };
    },
  } as unknown as Adapter;
  return { adapter, posts };
}

function splitBridge(adapter: Adapter, maxTextLength?: number) {
  return createChatSdkBridge({ adapter, supportsThreads: false, maxTextLength });
}

function textMessage(text: string, files?: OutboundFile[]): OutboundMessage {
  return { kind: 'chat-sdk', content: { text }, files };
}

const markdownOf = (posts: Post[]) => posts.map((p) => (p.message as { markdown: string }).markdown);

// Three parts under a limit of 12: each paragraph fits, no two fit together.
const TEXT = 'first part\n\nsecond part\n\nthird part';
const LIMIT = 12;

// Five parts under a limit of 10, for the retry cases.
const FIVE = 'part one\n\npart two\n\npart three\n\npart four\n\npart five';
const FIVE_LIMIT = 10;
/** Delivery attempts the host makes before it marks a message failed (MAX_DELIVERY_ATTEMPTS in src/delivery.ts). */
const ATTEMPTS = 3;

describe('createChatSdkBridge.deliver — reply split loop', () => {
  it('posts a text over maxTextLength as one message per part, in order, each within the limit, carrying the whole text', async () => {
    const { adapter, posts } = fakeAdapter();
    // One cut of each kind at a limit of 16: paragraph break, line break,
    // space, then a hard cut inside the run of x. At each cut the next kind
    // down would cut somewhere else, so the order of preference shows.
    const text = `one two\n\nthree\nfour five six ${'x'.repeat(25)}`;

    await splitBridge(adapter, 16).deliver('stub:C1', 'stub:C1:T1', textMessage(text));

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

    await splitBridge(adapter, LIMIT).deliver('stub:C1', null, textMessage(TEXT, [{ filename: 'report.pdf', data }]));

    expect(posts.map((p) => p.message)).toEqual([
      { markdown: 'first part', files: [{ data, filename: 'report.pdf' }] },
      { markdown: 'second part' },
      { markdown: 'third part' },
    ]);
  });

  it("returns the first part's id", async () => {
    const { adapter, posts } = fakeAdapter();

    const id = await splitBridge(adapter, LIMIT).deliver('stub:C1', null, textMessage(TEXT));

    expect(posts).toHaveLength(3);
    expect(id).toBe('id-1');
  });

  it('posts a text at or under maxTextLength once, unchanged', async () => {
    for (const limit of [TEXT.length, TEXT.length + 1]) {
      const { adapter, posts } = fakeAdapter();

      await splitBridge(adapter, limit).deliver('stub:C1', null, textMessage(TEXT));

      expect(posts.map((p) => p.message)).toEqual([{ markdown: TEXT }]);
    }
  });

  it('posts once, whatever the length, when the adapter sets no maxTextLength', async () => {
    const { adapter, posts } = fakeAdapter();
    const text = 'x'.repeat(50_000);

    await splitBridge(adapter).deliver('stub:C1', null, textMessage(text));

    expect(posts.map((p) => p.message)).toEqual([{ markdown: text }]);
  });

  it('today: part 3 of 5 failing once makes the retry post parts 1 and 2 again', async () => {
    const { adapter, posts } = fakeAdapter((call) => call === 3);
    const bridge = splitBridge(adapter, FIVE_LIMIT);

    await expect(bridge.deliver('stub:C1', null, textMessage(FIVE))).rejects.toThrow();
    // The loop stopped at the failed part: parts 4 and 5 were never tried.
    expect(markdownOf(posts)).toEqual(['part one', 'part two']);

    const id = await bridge.deliver('stub:C1', null, textMessage(FIVE));
    expect(markdownOf(posts)).toEqual([
      'part one',
      'part two',
      'part one',
      'part two',
      'part three',
      'part four',
      'part five',
    ]);
    // The id now points at the second copy of part 1.
    expect(id).toBe('id-3');
  });

  it('today: part 3 of 5 failing on every attempt posts parts 1 and 2 three times, and parts 3 to 5 never', async () => {
    const { adapter, posts } = fakeAdapter((_call, markdown) => markdown === 'part three');
    const bridge = splitBridge(adapter, FIVE_LIMIT);

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      await expect(bridge.deliver('stub:C1', null, textMessage(FIVE))).rejects.toThrow();
    }

    expect(markdownOf(posts)).toEqual(['part one', 'part two', 'part one', 'part two', 'part one', 'part two']);
  });

  it('today: the number of parts has no cap, a very long text posts as many parts as it needs', async () => {
    const { adapter, posts } = fakeAdapter();
    const text = 'x'.repeat(1_000_000);

    await splitBridge(adapter, 2000).deliver('stub:C1', null, textMessage(text));

    expect(posts).toHaveLength(500);
    expect(markdownOf(posts).join('')).toBe(text);
  });
});
