/**
 * Pins the handleSlashCommandUpdate override in telegram.ts: without it a bot_command
 * update never reaches onInbound. Drives the real registered factory; Bot API stubbed at fetch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { getChannelAdapterExact, initChannelAdapters, teardownChannelAdapters } from './channel-registry.js';
import './telegram.js';

vi.mock('../env.js', () => ({ readEnvFile: () => ({ TELEGRAM_BOT_TOKEN: 'test-token' }) }));
vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

type Update = Record<string, unknown>;
const queue: Update[] = [];
let pending: { resolve: (updates: Update[]) => void; reject: (err: Error) => void } | undefined;

/** Next getUpdates returns these, or resolves a poll already waiting. */
function deliver(update: Update): void {
  if (pending) {
    pending.resolve([update]);
    pending = undefined;
  } else {
    queue.push(update);
  }
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

const onInbound = vi.fn();

beforeAll(async () => {
  await runMigrations(await initTestDb());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const method = String(input).split('/').pop();
      if (method === 'getMe') return ok({ id: 1, is_bot: true, username: 'NanoClawBot' });
      if (method !== 'getUpdates') return ok({});
      if (queue.length > 0) return ok(queue.splice(0));
      const updates = await new Promise<Update[]>((resolve, reject) => {
        pending = { resolve, reject };
      });
      return ok(updates);
    }),
  );
  await initChannelAdapters(() => ({ onInbound, onInboundEvent: () => {}, onMetadata: () => {}, onAction: () => {} }));
  expect(getChannelAdapterExact('telegram')).toBeDefined();
});

afterAll(async () => {
  await teardownChannelAdapters();
  // The adapter has no disconnect hook, so end the waiting poll the way stopPolling would.
  pending?.reject(new DOMException('aborted', 'AbortError'));
  vi.unstubAllGlobals();
  await closeDb();
});

function update(chat: { id: number; type: string }, text: string): Update {
  return {
    update_id: chat.id,
    message: {
      message_id: 1,
      date: 1,
      chat,
      from: { id: 42, is_bot: false, first_name: 'A' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
    },
  };
}

describe('telegram slash commands reach the host inbound path', () => {
  it('forwards a DM bot_command (/clear) instead of swallowing it as a slash command', async () => {
    deliver(update({ id: 42, type: 'private' }, '/clear'));
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalled());
    expect(onInbound).toHaveBeenCalledWith(
      'telegram:42',
      expect.any(String),
      expect.objectContaining({ content: expect.objectContaining({ text: '/clear' }) }),
    );
  });

  it('forwards a group bot_command (/connect_group@bot) on the normal inbound path', async () => {
    onInbound.mockClear();
    deliver(update({ id: -1001, type: 'supergroup' }, '/connect_group@NanoClawBot'));
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalled());
    expect(onInbound).toHaveBeenCalledWith(
      'telegram:-1001',
      expect.any(String),
      expect.objectContaining({ content: expect.objectContaining({ text: '/connect_group@NanoClawBot' }) }),
    );
  });
});
