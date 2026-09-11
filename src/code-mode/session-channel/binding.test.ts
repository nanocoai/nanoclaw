/**
 * Binding a sandbox to its channel: one service create per group, the
 * binding row, the messaging group + wiring in session mode 'sandbox', and
 * what a repeat, a lost row, and a re-bind after an archive do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../cli/resources/destinations.js', () => ({
  projectDestinationsToSessions: vi.fn(async () => {}),
}));

import { projectDestinationsToSessions } from '../../cli/resources/destinations.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { resolveSession } from '../../session-manager.js';
import { SANDBOX_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { bindSessionChannel } from './binding.js';
import type { ChannelRecord } from './client.js';
import { getSessionChannelByGroup, updateSessionChannel } from './db.js';
import '../index.js';

const GROUP = { id: 'ag-bind-1', name: 'box', folder: 'box' };
const CREDS = { serviceBase: 'https://slack.example.test', appId: 'A1' };

function fakeCreate() {
  const calls: Array<{ appId: string; sessionId: string; title: string }> = [];
  let n = 0;
  const client = {
    create: vi.fn(async (input: { appId: string; sessionId: string; title: string }) => {
      calls.push(input);
      n += 1;
      const channel: ChannelRecord = { channelId: `C${n}`, sessionId: input.sessionId, status: 'active' };
      return { channel, created: true };
    }),
  };
  return { client, calls };
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({ ...GROUP, agent_provider: null, created_at: new Date().toISOString() });
  vi.mocked(projectDestinationsToSessions).mockClear();
});

afterEach(async () => {
  await closeDb();
});

describe('bindSessionChannel', () => {
  it('creates the channel once, stores the row, and wires the group in sandbox session mode', async () => {
    const { client, calls } = fakeCreate();
    const bound = await bindSessionChannel({ group: GROUP, credentials: CREDS, client });
    expect(bound.created).toBe(true);
    expect(calls).toEqual([{ appId: 'A1', sessionId: 'ag-bind-1', title: 'box' }]);

    const row = await getSessionChannelByGroup(GROUP.id);
    expect(row).toMatchObject({
      channel_id: 'C1',
      session_id: 'ag-bind-1',
      service_base: CREDS.serviceBase,
      app_id: 'A1',
      title: 'box',
      last_status: null,
      stopped_at: null,
      last_turn_seq: 0,
      archived_at: null,
    });

    const mg = await getMessagingGroupByPlatform('slack', 'C1', 'slack');
    expect(mg).toMatchObject({
      channel_type: 'slack',
      platform_id: 'C1',
      is_group: 1,
      unknown_sender_policy: 'public',
    });
    expect(row!.messaging_group_id).toBe(mg!.id);
    const wirings = await getMessagingGroupAgents(mg!.id);
    expect(wirings).toHaveLength(1);
    expect(wirings[0]).toMatchObject({
      agent_group_id: GROUP.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      session_mode: 'sandbox',
      threads: 0,
    });
    expect(projectDestinationsToSessions).toHaveBeenCalledWith(GROUP.id);
  });

  it('is idempotent: a second bind returns the same row without a second create or wiring', async () => {
    const { client, calls } = fakeCreate();
    const first = await bindSessionChannel({ group: GROUP, credentials: CREDS, client });
    const second = await bindSessionChannel({ group: GROUP, credentials: CREDS, client });
    expect(second.created).toBe(false);
    expect(second.row.channel_id).toBe(first.row.channel_id);
    expect(calls).toHaveLength(1);
    const mg = await getMessagingGroupByPlatform('slack', 'C1', 'slack');
    expect(await getMessagingGroupAgents(mg!.id)).toHaveLength(1);
    expect(projectDestinationsToSessions).toHaveBeenCalledTimes(1);
  });

  it("a message on the wired channel resolves to the group's coding session, not a chat session", async () => {
    const { client } = fakeCreate();
    const bound = await bindSessionChannel({ group: GROUP, credentials: CREDS, client });
    const { session, created } = await resolveSession(GROUP.id, bound.row.messaging_group_id, null, 'sandbox');
    expect(created).toBe(true); // the sandbox session did not exist yet in this test
    expect(session.thread_id).toBe(SANDBOX_SYSTEM_THREAD_ID);
    expect(session.messaging_group_id).toBeNull();
    const again = await resolveSession(GROUP.id, bound.row.messaging_group_id, 'some-thread', 'sandbox');
    expect(again.created).toBe(false);
    expect(again.session.id).toBe(session.id);
  });

  it('after an archive a new bind opens a fresh channel under a suffixed session id', async () => {
    const { client, calls } = fakeCreate();
    await bindSessionChannel({ group: GROUP, credentials: CREDS, client });
    const archivedAt = '2026-09-11T12:00:00.000Z';
    await updateSessionChannel(GROUP.id, { archived_at: archivedAt });

    const rebound = await bindSessionChannel({ group: GROUP, credentials: CREDS, client });
    expect(rebound.created).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].sessionId).toBe(`ag-bind-1.${Date.parse(archivedAt).toString(36)}`);
    const row = await getSessionChannelByGroup(GROUP.id);
    expect(row).toMatchObject({ channel_id: 'C2', archived_at: null, session_id: calls[1].sessionId });
    // The new channel got its own wiring; the old one's row stays as history of the platform id.
    const mg2 = await getMessagingGroupByPlatform('slack', 'C2', 'slack');
    expect(await getMessagingGroupAgents(mg2!.id)).toHaveLength(1);
  });

  it('a title override names the channel; the sandbox name is the default', async () => {
    const { client, calls } = fakeCreate();
    await bindSessionChannel({ group: GROUP, credentials: CREDS, client, title: 'Portal work' });
    expect(calls[0].title).toBe('Portal work');
    expect((await getSessionChannelByGroup(GROUP.id))!.title).toBe('Portal work');
  });
});
