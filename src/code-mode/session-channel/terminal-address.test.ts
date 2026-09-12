/**
 * Telling a channel where a terminal reaches its sandbox: the member update
 * keyed by the identity or, failing that, by the bot the channel record
 * names; a refusal is false, never a throw; and the sweep over every open
 * binding counts what it announced, skipped and failed.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';

import type { ChannelRecord, SessionChannelClient } from './client.js';
import type { SessionChannelRow } from './db.js';
import { announceTerminalAddress, announceTerminalAddresses, ownerBotUserId } from './terminal-address.js';

const FIELDS = { sandboxName: 'api', terminalAddress: 'api.alice.example.test' };

type Client = Pick<SessionChannelClient, 'get' | 'updateMember'>;

function row(over: Partial<SessionChannelRow> = {}): SessionChannelRow {
  return {
    agent_group_id: 'ag-1',
    channel_id: 'C1',
    session_id: 'ag-1',
    messaging_group_id: 'mg-1',
    service_base: 'https://slack.example.test',
    app_id: 'A1',
    title: 'api',
    last_status: null,
    last_status_at: null,
    stopped_at: null,
    last_turn_seq: 0,
    events_cursor: null,
    archived_at: null,
    created_at: '2026-09-11T10:00:00.000Z',
    updated_at: '2026-09-11T10:00:00.000Z',
    ...over,
  };
}

function fakeClient(record: Partial<ChannelRecord> = {}): {
  get: Mock<Client['get']>;
  updateMember: Mock<Client['updateMember']>;
} {
  const get: Mock<Client['get']> = vi.fn(async (channelId) => ({
    channelId,
    sessionId: 'ag-1',
    status: 'active',
    ...record,
  }));
  const updateMember: Mock<Client['updateMember']> = vi.fn(async (channelId, botUserId, fields) => ({
    channelId,
    member: { botUserId, role: 'owner', ...fields },
  }));
  return { get, updateMember };
}

describe('ownerBotUserId', () => {
  it('prefers the record’s own field, else the owner member, else nothing', () => {
    expect(ownerBotUserId({ botUserId: 'U0A' })).toBe('U0A');
    expect(
      ownerBotUserId({
        members: [
          { botUserId: 'U0B', role: 'member' },
          { botUserId: 'U0C', role: 'owner' },
        ],
      }),
    ).toBe('U0C');
    expect(ownerBotUserId({ botUserId: null, members: [{ botUserId: 'U0B', role: 'member' }] })).toBeUndefined();
    expect(ownerBotUserId({})).toBeUndefined();
  });
});

describe('announceTerminalAddress', () => {
  it('updates the member keyed by the identity without asking the service who the bot is', async () => {
    const client = fakeClient();
    expect(await announceTerminalAddress({ client, row: row(), fields: FIELDS, botUserId: 'U0BOT1' })).toBe(true);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.updateMember).toHaveBeenCalledExactlyOnceWith('C1', 'U0BOT1', FIELDS);
  });

  it('without an identity the channel record names the bot', async () => {
    const client = fakeClient({ botUserId: 'U0OWNER' });
    expect(await announceTerminalAddress({ client, row: row(), fields: FIELDS })).toBe(true);
    expect(client.get).toHaveBeenCalledExactlyOnceWith('C1');
    expect(client.updateMember).toHaveBeenCalledExactlyOnceWith('C1', 'U0OWNER', FIELDS);
  });

  it('a record that names no bot, a refused update, or an unreachable service is false — never a throw', async () => {
    const nameless = fakeClient({ botUserId: null });
    expect(await announceTerminalAddress({ client: nameless, row: row(), fields: FIELDS })).toBe(false);
    expect(nameless.updateMember).not.toHaveBeenCalled();

    const refusing = fakeClient();
    refusing.updateMember.mockRejectedValueOnce(new Error('404 no such member'));
    expect(await announceTerminalAddress({ client: refusing, row: row(), fields: FIELDS, botUserId: 'U0BOT1' })).toBe(
      false,
    );

    const down = fakeClient();
    down.get.mockRejectedValueOnce(new Error('unreachable'));
    expect(await announceTerminalAddress({ client: down, row: row(), fields: FIELDS })).toBe(false);
  });
});

describe('announceTerminalAddresses (the sweep after remote enable)', () => {
  it('announces every binding with an address, skips the rest, counts refusals', async () => {
    const client = fakeClient();
    client.updateMember.mockImplementation(async (channelId, botUserId, fields) => {
      if (channelId === 'C3') throw new Error('refused');
      return { channelId, member: { botUserId, role: 'owner', ...fields } };
    });
    const rows = [
      row(),
      row({ agent_group_id: 'ag-2', channel_id: 'C2' }), // a name that takes no address
      row({ agent_group_id: 'ag-3', channel_id: 'C3' }), // the service refuses
      row({ agent_group_id: 'ag-4', channel_id: 'C4' }), // group gone
      row({ agent_group_id: 'ag-5', channel_id: 'C5', service_base: 'https://other.example.test' }), // no bearer
    ];
    const names: Record<string, string | undefined> = { 'ag-1': 'api', 'ag-2': 'my_box', 'ag-3': 'web', 'ag-5': 'db' };
    const outcome = await announceTerminalAddresses({
      listBindings: async () => rows,
      sandboxNameOf: async (id) => names[id],
      fieldsOf: (sandbox) =>
        /^[a-z0-9-]+$/.test(sandbox)
          ? { sandboxName: sandbox, terminalAddress: `${sandbox}.alice.example.test` }
          : undefined,
      clientFor: (r) => (r.service_base === 'https://slack.example.test' ? client : null),
      botUserId: 'U0BOT1',
    });
    expect(outcome).toEqual({ announced: 1, skipped: 3, failed: 1 });
    expect(client.updateMember.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['C1', { sandboxName: 'api', terminalAddress: 'api.alice.example.test' }],
      ['C3', { sandboxName: 'web', terminalAddress: 'web.alice.example.test' }],
    ]);
  });

  it('no bindings is a quiet zero', async () => {
    expect(
      await announceTerminalAddresses({
        listBindings: async () => [],
        sandboxNameOf: async () => undefined,
        fieldsOf: () => undefined,
        clientFor: () => null,
      }),
    ).toEqual({ announced: 0, skipped: 0, failed: 0 });
  });
});
