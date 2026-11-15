/**
 * Telegram voice notes against the real @chat-adapter/telegram in polling
 * mode, through the real bridge to the host. Only fetch is faked, as a
 * Telegram API that long-polls.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: (keys: string[]) =>
    keys.includes('TELEGRAM_BOT_TOKEN') ? { TELEGRAM_BOT_TOKEN: '100:test-token' } : {},
}));

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import type { ChannelAdapter, InboundMessage } from './adapter.js';
import { createTelegramBridge } from './telegram.js';

const updates: unknown[] = [];
let wake: (() => void) | undefined;
const arrive = (update: Record<string, unknown>) => {
  updates.push(update);
  wake?.();
};

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (method === 'getMe') return ok({ id: 100, is_bot: true, first_name: 'Bot', username: 'test_bot' });
    if (method === 'getUpdates') {
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
    if (method === 'getFile') return ok({ file_id: 'f', file_path: 'media/file' });
    if (method === 'file') return new Response(new Uint8Array([1, 2, 3]));
    return ok({});
  }),
);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('a Telegram voice note', () => {
  let bridge: ChannelAdapter;
  const inbound = new Map<string, InboundMessage>();

  const media = (chatId: number, updateId: number, field: Record<string, unknown>) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Bob' },
      ...field,
    },
  });
  const attachmentsOf = (platformId: string) =>
    ((inbound.get(platformId)!.content as { attachments: Array<Record<string, unknown>> }).attachments ?? []).map(
      (a) => ({ type: a.type, ...('isVoiceNote' in a && { isVoiceNote: a.isVoiceNote }) }),
    );

  beforeEach(async () => {
    updates.length = 0;
    inbound.clear();
    await runMigrations(await initTestDb());
    bridge = createTelegramBridge()!;
    await bridge.setup({
      onInbound: (platformId, _threadId, message) => void inbound.set(platformId, message),
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    });
  });

  afterEach(async () => {
    await bridge.teardown();
    await closeDb();
  });

  it('reaches the host as a voice note, and a music file stays audio', async () => {
    arrive(
      media(42, 1, {
        voice: { file_id: 'v1', file_unique_id: 'uv1', duration: 3, mime_type: 'audio/ogg', file_size: 3 },
      }),
    );
    arrive(
      media(77, 2, {
        audio: {
          file_id: 'a1',
          file_unique_id: 'ua1',
          duration: 200,
          mime_type: 'audio/ogg',
          file_name: 'song.ogg',
          file_size: 3,
        },
      }),
    );
    await vi.waitFor(() => expect([...inbound.keys()].sort()).toEqual(['telegram:42', 'telegram:77']));

    expect(attachmentsOf('telegram:42')).toStrictEqual([{ type: 'voice', isVoiceNote: true }]);
    expect(attachmentsOf('telegram:77')).toStrictEqual([{ type: 'audio' }]);
  });
});
