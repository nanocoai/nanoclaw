/**
 * Telegram quick replies — integration with the delivery-action registry.
 *
 * Two things are guarded here, and both go red if the skill's wiring drifts:
 * the registration reaches the registry under the names the container tools
 * write, and `src/modules/index.ts` still imports the module (without that
 * line nothing registers at runtime, however green a direct unit test is).
 * The rest covers the payload the Bot API actually receives, and the refusal
 * paths that must not send at all.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

const dbState = vi.hoisted(() => ({
  group: { id: 'mg-1', is_group: 0 } as { id: string; is_group: number } | undefined,
  wiredAgentIds: ['ag-test'] as string[],
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroupByPlatform: vi.fn(async () => dbState.group),
  getMessagingGroupAgents: vi.fn(async () => dbState.wiredAgentIds.map((id) => ({ agent_group_id: id }))),
}));

const envState = vi.hoisted(() => ({ token: 'bot-token' as string | undefined }));
vi.mock('../../env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, envState.token])) as Record<string, string>,
  ),
}));

import { getDeliveryAction } from '../../delivery.js';
import type { Session } from '../../types.js';
import './index.js';

const session = { id: 'sess-1', agent_group_id: 'ag-test' } as Session;

function baseRow(over: Record<string, unknown> = {}) {
  return {
    action: 'telegram_quick_replies',
    channelType: 'telegram',
    platformId: 'telegram:-100999',
    threadId: null,
    text: 'Pick a shift',
    options: ['08:00', '16:00'],
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** The reply_markup the Bot API was actually called with, or null. */
function sentMarkup(): Record<string, unknown> | null {
  if (fetchMock.mock.calls.length === 0) return null;
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
  return body.reply_markup as Record<string, unknown>;
}

beforeEach(() => {
  dbState.group = { id: 'mg-1', is_group: 0 };
  dbState.wiredAgentIds = ['ag-test'];
  envState.token = 'bot-token';
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('telegram quick replies wiring', () => {
  it('registers both delivery actions under the names the container tools write', () => {
    expect(getDeliveryAction('telegram_quick_replies')).toBeDefined();
    expect(getDeliveryAction('telegram_clear_quick_replies')).toBeDefined();
  });

  it('is imported by the modules barrel — without this line nothing registers at runtime', () => {
    const barrel = fs.readFileSync(path.join(process.cwd(), 'src/modules/index.ts'), 'utf8');
    expect(barrel).toContain("./telegram-keyboards/index.js");
  });
});

describe('telegram quick replies payload', () => {
  it('builds a reply keyboard, wrapped at the requested column count', async () => {
    await getDeliveryAction('telegram_quick_replies')!(baseRow({ options: ['a', 'b', 'c'], columns: 2 }), session);

    const markup = sentMarkup() as { keyboard: Array<Array<{ text: string }>>; one_time_keyboard?: boolean };
    expect(markup.keyboard.map((row) => row.map((b) => b.text))).toEqual([['a', 'b'], ['c']]);
    // Default is a one-shot prompt: the keyboard goes away once used.
    expect(markup.one_time_keyboard).toBe(true);
  });

  it('keeps the keyboard open when persist is set', async () => {
    await getDeliveryAction('telegram_quick_replies')!(baseRow({ persist: true }), session);
    const markup = sentMarkup() as { is_persistent?: boolean; one_time_keyboard?: boolean };
    expect(markup.is_persistent).toBe(true);
    expect(markup.one_time_keyboard).toBeUndefined();
  });

  it('turns a contact request into request_contact in a private chat', async () => {
    await getDeliveryAction('telegram_quick_replies')!(
      baseRow({ options: [{ label: 'Share my number', request: 'contact' }] }),
      session,
    );
    const markup = sentMarkup() as { keyboard: Array<Array<{ request_contact?: boolean }>> };
    expect(markup.keyboard[0][0].request_contact).toBe(true);
  });

  it('refuses a contact request in a group — Telegram would silently ignore it', async () => {
    dbState.group = { id: 'mg-1', is_group: 1 };
    await getDeliveryAction('telegram_quick_replies')!(
      baseRow({ options: [{ label: 'Share my number', request: 'contact' }] }),
      session,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the keyboard with remove_keyboard', async () => {
    await getDeliveryAction('telegram_clear_quick_replies')!(
      { action: 'telegram_clear_quick_replies', channelType: 'telegram', platformId: 'telegram:-100999' },
      session,
    );
    expect(sentMarkup()).toMatchObject({ remove_keyboard: true });
  });
});

describe('telegram quick replies refusals', () => {
  it('does not send when the agent is not wired to the group', async () => {
    dbState.wiredAgentIds = ['ag-someone-else'];
    await getDeliveryAction('telegram_quick_replies')!(baseRow(), session);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send for a non-Telegram channel', async () => {
    await getDeliveryAction('telegram_quick_replies')!(baseRow({ channelType: 'whatsapp' }), session);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send when the bot token is missing', async () => {
    envState.token = undefined;
    await getDeliveryAction('telegram_quick_replies')!(baseRow(), session);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a malformed keyboard instead of calling the API', async () => {
    await getDeliveryAction('telegram_quick_replies')!(baseRow({ options: [] }), session);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
