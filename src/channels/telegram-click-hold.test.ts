/**
 * A click the host is slow to decide, against the real @chat-adapter/telegram
 * in polling mode. The adapter asks Telegram for more updates only once every
 * handler of the batch it has is done, so a click handler that waited for the
 * host held every chat. Only fetch is faked, as a Telegram API that long-polls.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: (keys: string[]) =>
    keys.includes('TELEGRAM_BOT_TOKEN') ? { TELEGRAM_BOT_TOKEN: '100:test-token' } : {},
}));

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import type { ChannelAdapter } from './adapter.js';
import { registerQuestionRenderResolver } from './question-render-registry.js';
import { createTelegramBridge } from './telegram.js';

const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
/** Updates Telegram holds for the bot, and the long poll waiting for the next one. */
const updates: unknown[] = [];
let wake: (() => void) | undefined;
const arrive = (update: Record<string, unknown>) => {
  updates.push(update);
  wake?.();
};

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (method === 'getMe') return ok({ id: 100, is_bot: true, first_name: 'Bot', username: 'test_bot' });
    if (method === 'getUpdates') {
      // A long poll: answered at once when there is something, else when something arrives.
      if (updates.length === 0) {
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          });
        });
      }
      wake = undefined;
      return ok(updates.splice(0));
    }
    sent.push({ method, body });
    return ok({ message_id: 500 + sent.length, chat: { id: body.chat_id ?? 42, type: 'private' }, date: 0, text: '' });
  }),
);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('a Telegram click the host is slow to decide', () => {
  let bridge: ChannelAdapter;
  const inbound: string[] = [];
  /** Clicks at the host, each held until the test settles it. */
  const held: Array<{ questionId: string; settle: (outcome: 'accepted' | 'ignored') => void }> = [];
  const edits = () => sent.filter((call) => call.method === 'editMessageText');

  /** Sends a card through the bridge and returns the click Telegram would send for its first button. */
  const cardAndClick = async (questionId: string, chatId: number, updateId: number) => {
    const before = sent.length;
    await bridge.deliver(`telegram:${chatId}`, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId,
        title: 'Review',
        question: 'Allow?',
        options: [{ label: 'Approve' }],
      },
    });
    const card = sent.slice(before).find((call) => call.method === 'sendMessage')!;
    const markup = card.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    return {
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        from: { id: 7, is_bot: false, first_name: 'Ann' },
        chat_instance: 'x',
        data: markup.inline_keyboard[0][0].callback_data,
        message: { message_id: 500 + sent.length, date: 0, chat: { id: chatId, type: 'private' } },
      },
    };
  };
  const message = (chatId: number, updateId: number, text: string) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Bob' },
      text,
    },
  });

  beforeEach(async () => {
    sent.length = updates.length = inbound.length = held.length = 0;
    await runMigrations(await initTestDb());
    registerQuestionRenderResolver((id) =>
      id.startsWith('q-held')
        ? {
            title: 'Review',
            question: 'Allow?',
            options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
          }
        : undefined,
    );
    bridge = createTelegramBridge()!;
    await bridge.setup({
      onInbound: (platformId) => void inbound.push(platformId),
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: (questionId) => new Promise((settle) => held.push({ questionId, settle })),
    });
  });

  afterEach(async () => {
    // A click still held would keep the polling loop, and so the teardown, waiting.
    for (const click of held) click.settle('ignored');
    await bridge.teardown();
    await closeDb();
  });

  it("lets another chat's message reach the host while the click is still undecided", async () => {
    arrive(await cardAndClick('q-held-1', 42, 1));
    await vi.waitFor(() => expect(held).toHaveLength(1));

    arrive(message(77, 2, 'hello from another chat'));
    await vi.waitFor(() => expect(inbound).toEqual(['telegram:77']));
    // Nothing is shown until the host decides.
    expect(edits()).toHaveLength(0);

    held[0].settle('accepted');
    await vi.waitFor(() => expect(edits()).toHaveLength(1));
    expect(JSON.stringify(edits()[0].body)).toContain('Approved');
  });

  it('hands a second click in the same chat to the host in the order it came, the first still undecided', async () => {
    const first = await cardAndClick('q-held-1', 42, 1);
    arrive(first);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const second = await cardAndClick('q-held-2', 42, 2);
    arrive(second);
    await vi.waitFor(() => expect(held.map((click) => click.questionId)).toEqual(['q-held-1', 'q-held-2']));

    // Each card changes when its own click is decided, whichever comes first.
    const edited = () => edits().map((call) => call.body.message_id);
    held[1].settle('accepted');
    await vi.waitFor(() => expect(edited()).toEqual([second.callback_query.message.message_id]));
    held[0].settle('accepted');
    await vi.waitFor(() =>
      expect(edited()).toEqual([second.callback_query.message.message_id, first.callback_query.message.message_id]),
    );
    expect(first.callback_query.message.message_id).not.toBe(second.callback_query.message.message_id);
  });
});
