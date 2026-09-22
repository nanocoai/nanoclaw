/**
 * Telegram quick-reply MCP tools — the payload the host reads back.
 *
 * The tools' only job is to write a `system` row whose `action` and routing
 * fields the host's delivery action understands, so these tests assert that
 * contract rather than any keyboard shape (the markup is built host-side and
 * tested there). The barrel assertion guards the one reach-in: without that
 * import nothing registers in a real container, however green the rest is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendQuickReplies, clearQuickReplies } from './telegram-keyboard.js';

function seedDestination(name: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function lastPayload(): Record<string, unknown> {
  const out = getUndeliveredMessages();
  expect(out).toHaveLength(1);
  return JSON.parse(out[0].content as string) as Record<string, unknown>;
}

beforeEach(() => {
  initTestSessionDb();
  seedDestination('tg-group', 'telegram', 'telegram:-100999');
  seedDestination('wa-group', 'whatsapp', '972500000000@g.us');
});

afterEach(() => {
  closeSessionDb();
});

describe('send_quick_replies', () => {
  it('writes a system row the telegram_quick_replies delivery action can read', async () => {
    await sendQuickReplies.handler({ to: 'tg-group', text: 'Pick a shift', options: ['08:00', '16:00'] });

    const payload = lastPayload();
    expect(payload.action).toBe('telegram_quick_replies');
    expect(payload.channelType).toBe('telegram');
    expect(payload.platformId).toBe('telegram:-100999');
    expect(payload.text).toBe('Pick a shift');
    expect(payload.options).toEqual(['08:00', '16:00']);
  });

  it('passes columns and persist through only when set', async () => {
    await sendQuickReplies.handler({ to: 'tg-group', text: 'x', options: ['a'], columns: 3, persist: true });
    const payload = lastPayload();
    expect(payload.columns).toBe(3);
    expect(payload.persist).toBe(true);
  });

  it('omits columns and persist when not set, so host defaults apply', async () => {
    await sendQuickReplies.handler({ to: 'tg-group', text: 'x', options: ['a'] });
    const payload = lastPayload();
    expect(payload).not.toHaveProperty('columns');
    expect(payload).not.toHaveProperty('persist');
  });

  it('tells the agent when the destination is not on Telegram, and writes nothing', async () => {
    const res = await sendQuickReplies.handler({ to: 'wa-group', text: 'x', options: ['a'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Telegram');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects an unknown destination without writing', async () => {
    const res = await sendQuickReplies.handler({ to: 'nope', text: 'x', options: ['a'] });
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects empty options and empty text without writing', async () => {
    expect((await sendQuickReplies.handler({ to: 'tg-group', text: 'x', options: [] })).isError).toBe(true);
    expect((await sendQuickReplies.handler({ to: 'tg-group', text: '  ', options: ['a'] })).isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('clear_quick_replies', () => {
  it('writes the removal action', async () => {
    await clearQuickReplies.handler({ to: 'tg-group' });
    const payload = lastPayload();
    expect(payload.action).toBe('telegram_clear_quick_replies');
    expect(payload.platformId).toBe('telegram:-100999');
  });
});

describe('wiring', () => {
  it('is imported by the mcp-tools barrel — without this line the tools never register', () => {
    const barrel = fs.readFileSync(path.join(import.meta.dir, 'index.ts'), 'utf8');
    expect(barrel).toContain("./telegram-keyboard.js");
  });
});
